<template>
  <div class="sim-view">
    <!-- 编排配置 -->
    <el-card shadow="never" class="cfg-card">
      <template #header>
        <div class="card-head">
          <span>{{ cfg.title }}（上层应用编排模拟器）</span>
          <span class="head-sub">
            调度只负责移动（抢占 → 导航到点）；{{ cfg.actionName }}动作由本模块直连 RMS start-activity 下发，与调度内核解耦
          </span>
        </div>
      </template>
      <div class="cfg-row">
        <div class="cfg-item">
          <span class="cfg-label">机器人</span>
          <el-select v-model="robotCode" placeholder="选择机器人" style="width: 220px" :disabled="running">
            <el-option v-for="r in robots" :key="r.robot_code" :value="r.robot_code"
                       :label="`${r.robot_name || r.robot_code}（${r.battery ?? '?'}%）`"
                       :disabled="r.online_status !== 'online'" />
          </el-select>
        </div>
        <div class="cfg-item">
          <span class="cfg-label">{{ cfg.pointLabel }}</span>
          <el-select v-model="pointId" :placeholder="`选择${cfg.pointLabel}`" style="width: 200px" :disabled="running">
            <el-option v-for="w in workPoints" :key="w.id" :value="w.id" :label="`${w.name}（${w.id}）`" />
          </el-select>
        </div>
        <div class="cfg-item">
          <span class="cfg-label">模板 code</span>
          <el-input v-model="templateCode" style="width: 180px" :disabled="running" />
        </div>
        <div class="cfg-actions">
          <el-button type="primary" :loading="running" :disabled="!canRun" @click="runFull">
            一键执行全流程
          </el-button>
          <el-button :disabled="running || !canRun" @click="runMoveOnly">仅移动到位</el-button>
          <el-button :disabled="running || !robotCode" @click="runActionOnly">
            仅发{{ cfg.actionName }}（需已到位）
          </el-button>
          <el-button type="danger" plain :disabled="!running" @click="abort">中止</el-button>
        </div>
      </div>
    </el-card>

    <!-- 步骤 -->
    <el-card shadow="never" class="steps-card">
      <el-steps :active="activeStep" align-center finish-status="success">
        <el-step v-for="s in steps" :key="s.key" :title="s.title" :status="s.status"
                 :description="s.desc" />
      </el-steps>
    </el-card>

    <div class="panels">
      <!-- 编排日志（sessionStorage 持久化，刷新不丢） -->
      <el-card shadow="never" class="log-card">
        <template #header>
          <div class="log-head">
            <span>编排日志</span>
            <el-button size="small" text type="danger" @click="clearLogs">清空</el-button>
          </div>
        </template>
        <div ref="logBox" class="log-box">
          <div v-if="logs.length === 0" class="log-empty">暂无执行记录</div>
          <div v-for="(l, i) in logs" :key="i" class="log-line" :class="'lv-' + l.level">
            <span class="log-time">{{ l.time }}</span>
            <span class="log-tag">{{ l.tag }}</span>
            <span class="log-text">{{ l.text }}</span>
          </div>
        </div>
      </el-card>

      <!-- 动作结果 -->
      <el-card shadow="never" class="result-card">
        <template #header><span>{{ cfg.resultTitle }}</span></template>
        <div v-if="!result" class="log-empty">暂无结果</div>
        <template v-else>
          <div class="result-head">
            <el-tag v-if="overallText" :type="overallText === 'NG' ? 'danger' : 'success'" size="large" effect="dark">
              {{ overallText }}
            </el-tag>
            <el-tag v-else type="success" size="large" effect="plain">动作完成</el-tag>
            <span v-if="cfg.kind === 'qc'" class="result-meta">
              {{ result.wireharness_type ?? '--' }} · 条码 {{ result.wireharness_barcode ?? '--' }} ·
              {{ result.task_id ?? '--' }}
            </span>
          </div>
          <el-table v-if="resultItems.length > 0" :data="resultItems" size="small" border>
            <el-table-column prop="point_id" label="点位" width="60" />
            <el-table-column prop="camera_id" label="相机" width="120" />
            <el-table-column prop="type" label="检测项" width="100" />
            <el-table-column label="结果" width="70">
              <template #default="{ row }">
                <el-tag :type="row.result === 'NG' ? 'danger' : 'success'" size="small">{{ row.result }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="error_reason" label="原因" min-width="140" />
          </el-table>
          <el-collapse class="raw-collapse">
            <el-collapse-item title="原始报文" name="raw">
              <pre class="raw-json">{{ JSON.stringify(result, null, 2) }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { schedulerApi, rmsApi } from '@/api/scheduler'
import { runMoveFlow } from '@/utils/moveFlow'
import { snowflakeId, bizTaskId } from '@/utils/snowflake'
import type { RobotInfo } from '@/types'

/**
 * 业务动作模拟器（上层应用编排替身，不属于调度层）：
 * 质检 / 充电 共用同一编排——抢占 → 调度移动 → start-activity → 镜像读结果 → 释放。
 * 差异仅是配置（点位类型/模板/契约字段），由路由 props 决定。
 */

const props = defineProps<{ kind: 'qc' | 'charge' }>()

const CONFIGS = {
  qc: {
    kind: 'qc' as const, title: '质检模拟', actionName: '质检', pointLabel: '质检点',
    pointType: 'workstation', category: 'quality_inspection', defaultTemplate: 'LAD-28-A-not-lift',
    resultTitle: '质检结果', logKey: 'qcsim-logs', stepTitle: '质检动作（RMS）',
  },
  charge: {
    kind: 'charge' as const, title: '充电模拟', actionName: '充电', pointLabel: '充电点',
    pointType: 'charge', category: 'charge', defaultTemplate: 'back-charge',
    resultTitle: '充电结果', logKey: 'chargesim-logs', stepTitle: '充电动作（RMS）',
  },
}
const cfg = CONFIGS[props.kind]

const robots = ref<RobotInfo[]>([])
const workPoints = ref<{ id: string; name: string; x: number; y: number; theta: number }[]>([])
const robotCode = ref('')
const pointId = ref('')
const templateCode = ref(cfg.defaultTemplate)

const running = ref(false)
const abortFlag = ref(false)
const result = ref<any>(null)
const logBox = ref<HTMLElement>()

const steps = reactive([
  { key: 'assign', title: '抢占机器人', status: 'wait' as 'wait' | 'process' | 'success' | 'error', desc: '' },
  { key: 'move', title: '调度移动到点', status: 'wait' as 'wait' | 'process' | 'success' | 'error', desc: '' },
  { key: 'action', title: cfg.stepTitle, status: 'wait' as 'wait' | 'process' | 'success' | 'error', desc: '' },
  { key: 'release', title: '释放机器人', status: 'wait' as 'wait' | 'process' | 'success' | 'error', desc: '' },
])
const activeStep = computed(() => {
  const idx = steps.findIndex(s => s.status === 'error')
  if (idx >= 0) return idx
  return steps.filter(s => s.status === 'success').length
})

const canRun = computed(() => !!robotCode.value && !!pointId.value)
const overallText = computed(() => result.value?.inspection_result ?? null)
const resultItems = computed(() => {
  const items: any[] = []
  for (const p of result.value?.points ?? []) {
    for (const it of p.items ?? []) items.push({ point_id: p.point_id, camera_id: p.camera_id, ...it })
  }
  return items
})

const LOG_MAX = 200
const logs = ref<{ time: string; tag: string; text: string; level: string }[]>(loadLogs())
function loadLogs(): { time: string; tag: string; text: string; level: string }[] {
  try {
    const raw = sessionStorage.getItem(cfg.logKey)
    return raw ? (JSON.parse(raw) as any[]) : []
  } catch { return [] }
}
function persistLogs() {
  try { sessionStorage.setItem(cfg.logKey, JSON.stringify(logs.value.slice(-LOG_MAX))) } catch { /* 存储满忽略 */ }
}
function log(tag: string, text: string, level = 'info') {
  logs.value.push({
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    tag, text, level,
  })
  if (logs.value.length > LOG_MAX) logs.value = logs.value.splice(logs.value.length - LOG_MAX)
  persistLogs()
  nextTick(() => logBox.value?.scrollTo({ top: logBox.value.scrollHeight }))
}
/** 清空编排日志 */
function clearLogs() {
  logs.value = []
  persistLogs()
}
function resetSteps() {
  steps.forEach(s => { s.status = 'wait'; s.desc = '' })
  result.value = null
}
function setStep(key: string, status: 'process' | 'success' | 'error', desc = '') {
  const s = steps.find(x => x.key === key); if (s) { s.status = status; s.desc = desc }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await refreshBase()
  pollTimer = setInterval(refreshRobots, 5000)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); abortFlag.value = true })

async function refreshBase() {
  await Promise.all([refreshRobots(), refreshPoints()])
}
async function refreshRobots() {
  try { robots.value = await schedulerApi.robots() } catch { /* 忽略 */ }
}
async function refreshPoints() {
  try {
    const wps = await schedulerApi.mapWaypoints(undefined, cfg.pointType) as any[]
    workPoints.value = (wps ?? []).map(w => ({
      id: String(w.id), name: String(w.name ?? w.id),
      x: Number(w.x), y: Number(w.y), theta: Number(w.theta ?? 0),
    }))
  } catch { /* 忽略 */ }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function throwIfAbort() { if (abortFlag.value) throw new Error('已中止') }

/** 等待动作结果：从调度观测镜像轮询（调度镜像落档后会兜底 ack 清空 RMS 信箱，
 *  信箱里的回执是瞬态的，不能作为上层读取源） */
async function waitActionResult(robot: string, bodyTaskId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAbort()
    const res = await schedulerApi.activities({ task_id: bodyTaskId, page_num: 1, page_size: 10 }).catch(() => null)
    const found = (res?.list ?? []).find((a: any) => a.body_task_id === bodyTaskId && a.robot_code === robot)
    if (found) {
      if (found.action_status === 3) {
        return found.result_report ?? {}
      }
      throw new Error(`${cfg.actionName}未成功（action_status=${found.action_status ?? '?'}）: ${found.failure_msg ?? '无失败详情'}`)
    }
    await sleep(2000)
  }
  throw new Error(`${cfg.actionName}结果等待超时`)
}

/** 构造 start-activity 报文（上层应用契约）。
 *  充电契约差异（对齐旧栈 wireChargeActivity）：activity 字段放模板 code（机器人按模板 code 查模板），
 *  非充电动作放固定类型名。 */
function buildActivityBody(tf: string, bodyTaskId: string, rmfTaskId: string, cmdId: number) {
  const pt = workPoints.value.find(w => w.id === pointId.value)
  return {
    activity: cfg.kind === 'charge' ? templateCode.value : cfg.category,
    description: {
      rmf_task_id: rmfTaskId,
      task_template_type: cfg.category,
      task_template_code: templateCode.value,
      end_point: pointId.value,
      destination: { x: pt?.x ?? 0, y: pt?.y ?? 0, yaw: pt?.theta ?? 0 },
      task_id: bodyTaskId,
      taskflow_id: tf,
      nav_target_point: pointId.value,
    },
    label: `${tf}|${templateCode.value}`,
    cmd_id: cmdId,
  }
}

// ---------------- 三种执行入口 ----------------

/** 一键全流程：抢占 → 移动 → 动作 → 释放 */
async function runFull() { await orchestrate(true, true) }

/** 仅移动：抢占 → 移动 → 释放（不做业务动作） */
async function runMoveOnly() { await orchestrate(true, false) }

/** 仅动作：直接发 start-activity（机器人须已在点位）；task_id 同业务规则（雪花+时间戳） */
async function runActionOnly() {
  if (!robotCode.value) return
  running.value = true; abortFlag.value = false
  resetSteps()
  const tf = snowflakeId()
  const bodyTaskId = bizTaskId(tf)
  try {
    setStep('action', 'process')
    log(cfg.actionName, `直接下发 start-activity → ${robotCode.value} @ ${pointId.value || '(在位点)'}`)
    await sendAndWaitAction(tf, bodyTaskId, `${cfg.kind}sim.${bodyTaskId}`)
    setStep('action', 'success', `${cfg.actionName}完成`)
  } catch (e: any) {
    setStep('action', 'error', e?.message ?? '失败')
    log(cfg.actionName, e?.message ?? '失败', 'error')
    ElMessage.error(`${cfg.actionName}失败: ${e?.message ?? '未知错误'}`)
  } finally {
    running.value = false
  }
}

/** 编排执行（移动闭环由 moveFlow 驱动：抢占→移动→动作(midAction)→释放） */
async function orchestrate(withMove: boolean, withAction: boolean) {
  running.value = true; abortFlag.value = false
  resetSteps()
  let flowTaskId = ''
  try {
    await runMoveFlow({
      robotCode: robotCode.value,
      pointId: pointId.value,
      onEvent: (step, phase, text) => {
        const key = step === 'extra' ? 'action' : step
        setStep(key, phase === 'start' ? 'process' : phase === 'ok' ? 'success' : 'error', text)
        log({ assign: '抢占', move: '移动', action: cfg.actionName, release: '释放' }[key] ?? step, text,
          phase === 'fail' ? 'error' : 'info')
      },
      midAction: withAction
        ? async (ctx) => {
            flowTaskId = ctx.taskId
            await sendAndWaitAction(ctx.taskflowId, ctx.taskId, `${cfg.kind}sim.${ctx.taskId}`)
          }
        : undefined,
    })
    if (withAction) {
      const overall = overallText.value ?? '完成'
      ElMessage.success(`${cfg.actionName}流程完成，结果 ${overall}`)
    } else {
      ElMessage.success('移动到位，机器人已释放')
    }
  } catch (e: any) {
    const msg = e?.message ?? '未知错误'
    log('编排', msg, 'error')
    ElMessage.error(msg)
    // 移动阶段中止 → 尝试取消调度任务
    if (abortFlag.value && flowTaskId) {
      try { await schedulerApi.stopTask(flowTaskId, `${cfg.title}中止`) } catch { /* 忽略 */ }
    }
  } finally {
    running.value = false
  }
}

/** 下发 start-activity 并等待回执结果（模板由人工预置到机器人容器，本模块不下发） */
const activeAction = ref<{ robotCode: string; bodyTaskId: string; cmdId: number } | null>(null)
async function sendAndWaitAction(tf: string, bodyTaskId: string, rmfTaskId: string) {
  const cmdId = 1
  activeAction.value = { robotCode: robotCode.value, bodyTaskId, cmdId }
  try {
    const body = buildActivityBody(tf, bodyTaskId, rmfTaskId, cmdId)
    log(cfg.actionName, `start-activity cmd_id=${cmdId} 模板=${templateCode.value}`)
    const accepted = await rmsApi.startActivity(robotCode.value, body)
    log(cfg.actionName, `RMS 受理: ${accepted?.body_task_status ?? accepted?.result_code ?? 'accepted'}`)
    const report = await waitActionResult(robotCode.value, bodyTaskId, 300000)
    result.value = report
    const overall = overallText.value ?? '完成'
    log(cfg.actionName, `完成，结果 ${overall}`, overall === 'NG' ? 'warn' : 'info')
  } finally {
    activeAction.value = null
  }
}

/** 中止当前编排：动作阶段先停 RMS 本体任务（机器人还在执行动作），轮询循环随后退出 */
function abort() {
  abortFlag.value = true
  const active = activeAction.value
  if (active) {
    rmsApi.stopBodyTask(active.robotCode, active.bodyTaskId, active.cmdId)
      .then((r: any) => log('中止', `RMS stop 已发出（${r?.data?.accepted === false ? r?.data?.reject_reason : '受理'}）`))
      .catch((e: any) => log('中止', `RMS stop 发送失败: ${e?.message ?? ''}`, 'warn'))
  } else {
    log('编排', '收到中止请求，等待当前轮询退出...', 'warn')
  }
}
</script>

<style scoped>
.sim-view { display: flex; flex-direction: column; gap: 12px; height: 100%; }
.cfg-card :deep(.el-card__header) { padding: 10px 16px; }
.card-head { display: flex; align-items: baseline; gap: 12px; }
.head-sub { font-size: 11px; color: #909399; font-weight: normal; }
.cfg-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.cfg-item { display: flex; align-items: center; gap: 8px; }
.cfg-label { font-size: 13px; color: #606266; white-space: nowrap; }
.cfg-actions { margin-left: auto; display: flex; gap: 8px; }
.steps-card :deep(.el-card__body) { padding: 16px 8px; }
.panels { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; flex: 1; min-height: 0; }
.log-card, .result-card { display: flex; flex-direction: column; min-height: 260px; }
.log-head { display: flex; justify-content: space-between; align-items: center; }
.log-card :deep(.el-card__body), .result-card :deep(.el-card__body) { flex: 1; overflow: auto; }
.log-box { font-size: 12px; line-height: 1.7; }
.log-empty { color: #c0c4cc; text-align: center; padding: 32px 0; }
.log-line { display: flex; gap: 8px; }
.log-time { color: #c0c4cc; font-family: Consolas, monospace; flex-shrink: 0; }
.log-tag { color: #409eff; flex-shrink: 0; width: 34px; }
.log-text { color: #303133; word-break: break-all; }
.lv-error .log-text { color: #f56c6c; }
.lv-warn .log-text { color: #e6a23c; }
.result-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.result-meta { font-size: 12px; color: #909399; }
.raw-collapse { margin-top: 10px; }
.raw-json { font-size: 11px; background: #f5f7fa; border-radius: 4px; padding: 8px; max-height: 240px; overflow: auto; }
</style>
