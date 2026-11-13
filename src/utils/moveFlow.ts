import { schedulerApi } from '@/api/scheduler'
import { snowflakeId, bizTaskId } from '@/utils/snowflake'

/**
 * 移动业务流编排（新版架构统一语义：抢占 → 调度移动 → [业务动作] → 释放）。
 * 调度只负责移动；本模块模拟上层应用的资源占用闭环。
 * MapView 快捷移动不带 midAction（纯移动）；质检模拟把 start-activity 塞进 midAction。
 */

export type FlowStep = 'assign' | 'move' | 'extra' | 'release'
export type FlowPhase = 'start' | 'ok' | 'fail'

export interface MoveFlowOptions {
  robotCode: string
  pointId: string
  /** 移动终态等待超时（毫秒），默认 300s */
  timeoutMs?: number
  /** 移动到位后、释放前的业务动作（质检/充电等）；抛错则整个流失败但机器人仍会释放。
   *  长动作期间自动发送所有权心跳（60s 间隔）防租约看门狗误回收 */
  midAction?: (ctx: MoveFlowResult) => Promise<void>
  /** 结构化步骤事件（步骤条 UI / 日志） */
  onEvent?: (step: FlowStep, phase: FlowPhase, text: string) => void
}

export interface MoveFlowResult {
  taskflowId: string
  taskId: string
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 孤儿占用自愈：抢占 409 时按 USAGE 事件流找回该机器人最近一次未释放的占用
 * （浏览器刷新/崩溃导致业务流中断），代为释放。返回是否成功解救。
 */
async function rescueStaleOccupancy(
  robotCode: string,
  emit: (step: FlowStep, phase: FlowPhase, text: string) => void,
): Promise<boolean> {
  try {
    const res = await schedulerApi.robotEvents({ robot_code: robotCode, event_type: 'USAGE', page_num: 1, page_size: 50 })
    const events = (res?.list ?? []) as Array<{ reason: string; new_value: string | null; last_at: number }>
    const latest = events
      .filter(e => e.reason === 'OCCUPIED' && e.new_value)
      .sort((a, b) => b.last_at - a.last_at)[0]
    if (!latest) return false
    const released = events.some(e => e.reason === 'RELEASED' && e.new_value === latest.new_value
      && e.last_at >= latest.last_at)
    if (released) return false
    // 活跃流保护：占用不到 3 分钟视为正常在途业务流，不误释放（只有长时间孤儿才解救）
    if (Date.now() - latest.last_at < 3 * 60_000) return false
    emit('assign', 'start', `发现孤儿占用（taskflow ${latest.new_value}），代为释放`)
    await schedulerApi.releaseRobot(latest.new_value!, robotCode)
    emit('assign', 'start', '孤儿占用已释放，重试抢占')
    return true
  } catch {
    return false
  }
}

/**
 * 执行 抢占→移动→[midAction]→释放 全闭环；任何阶段失败都会尝试释放后抛出。
 */
export async function runMoveFlow(o: MoveFlowOptions): Promise<MoveFlowResult> {
  const timeoutMs = o.timeoutMs ?? 300_000
  // taskflow_id = 雪花 ID（对齐上层任务流语义）；
  // task_id = 任务流 ID + 发布时间 yyyyMMddHHmmssSSS（真机端契约：时间后缀直接反映发布先后顺序）
  const tf = snowflakeId()
  const taskId = bizTaskId(tf)
  const emit = (step: FlowStep, phase: FlowPhase, text: string) => o.onEvent?.(step, phase, text)
  let assigned = false
  try {
    emit('assign', 'start', `assign-task: ${o.robotCode}`)
    try {
      await schedulerApi.assignRobot(tf, o.robotCode)
    } catch (e: any) {
      // 占用冲突自愈：上次业务流因浏览器刷新/崩溃未释放 → 按事件流找回孤儿占用并释放后重试
      if (e?.response?.status === 409 && (await rescueStaleOccupancy(o.robotCode, emit))) {
        await schedulerApi.assignRobot(tf, o.robotCode)
      } else {
        throw e
      }
    }
    assigned = true
    emit('assign', 'ok', '机器人已占用')

    emit('move', 'start', `goto-place → ${o.pointId}`)
    await schedulerApi.gotoPlace(tf, taskId, o.robotCode, o.pointId)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (Date.now() > deadline) throw new Error('移动任务等待超时')
      const d = await schedulerApi.taskStatus(taskId).catch(() => null)
      // 契约字段：task_status（旧 API polished status）
      const st = d?.task_status ?? d?.status ?? d?.state
      if (st === 'completed') break
      if (st === 'failed' || st === 'canceled') {
        throw new Error(`移动任务${st === 'failed' ? '失败' : '已取消'}: ${d?.message ?? ''}`)
      }
      await sleep(2000)
    }
    emit('move', 'ok', '已到位')

    if (o.midAction) {
      emit('extra', 'start', '业务动作执行中')
      // 长动作心跳：业务动作直连 RMS 期间调度侧无任务在身，需显式续约防孤儿回收（默认租约 120s）
      const heartbeat = setInterval(() => {
        schedulerApi.ownershipHeartbeat(tf).catch(() => { /* 心跳失败不阻断业务 */ })
      }, 60_000)
      try {
        await o.midAction({ taskflowId: tf, taskId })
        emit('extra', 'ok', '业务动作完成')
      } catch (e: any) {
        emit('extra', 'fail', e?.message ?? '业务动作失败')
        throw e
      } finally {
        clearInterval(heartbeat)
      }
    }
    return { taskflowId: tf, taskId }
  } catch (e: any) {
    if (assigned) emit('release', 'start', '异常收尾释放')
    throw e
  } finally {
    if (assigned) {
      try {
        await schedulerApi.releaseRobot(tf, o.robotCode)
        emit('release', 'ok', '机器人已释放')
      } catch (e: any) {
        emit('release', 'fail', `释放失败: ${e?.message ?? ''}`)
      }
    }
  }
}
