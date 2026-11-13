/**
 * 雪花 ID 生成（64 位，字符串形式防 JS Number 2^53 精度丢失）。
 * 对齐上层应用语义：taskflow_id = 任务流创建时数据库生成的雪花 ID。
 * 结构：1 符号位 + 41 时间戳（自定义纪元 2026-01-01）+ 5 机器位 + 12 序列位。
 */

// 自定义纪元：2026-01-01T00:00:00Z（毫秒）
const EPOCH = 1_767_225_600_000n

// 机器位：会话级随机（0-31），多标签页/多客户端降低撞位概率
const MACHINE = BigInt(Math.floor(Math.random() * 32))

let lastTs = 0n
let seq = 0n

export function snowflakeId(): string {
  let now = BigInt(Date.now())
  if (now === lastTs) {
    seq = (seq + 1n) & 0xfffn // 12 位序列
    if (seq === 0n) {
      // 同毫秒序列耗尽，等待下一毫秒
      while (now === lastTs) now = BigInt(Date.now())
    }
  } else {
    seq = 0n
  }
  lastTs = now
  return (((now - EPOCH) << 22n) | (MACHINE << 12n) | seq).toString()
}

/**
 * 业务任务 ID 规则（真机端契约）：
 * task_id = taskflow_id + 任务发布时间（yyyyMMddHHmmssSSS，24 小时制含毫秒，17 位）
 * 时间后缀直接反映任务发布先后顺序，便于机器人端排序与排查。
 */
export function bizTaskTimestamp(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/** 基于任务流 ID 生成业务任务 ID（taskflowId + 发布时间戳后缀） */
export function bizTaskId(taskflowId: string, ts: number = Date.now()): string {
  return `${taskflowId}${bizTaskTimestamp(ts)}`
}
