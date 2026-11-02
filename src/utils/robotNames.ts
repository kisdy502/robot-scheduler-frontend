/**
 * 机器人显示名注册表（前端本地缓存）：
 * 后端名称来自 30s TTL 缓存，mock 重启/新增机器人的窗口期 robot_name 会退化为编码，
 * 导致页面一会儿显示名字一会儿显示编码。前端记住见过的 code→name 映射，
 * 后端退化时沿用上次已知名字，保证显示稳定。
 */
const knownNames = new Map<string, string>()

export interface NameCarrier {
  robot_code: string
  robot_name?: string | null
}

/** 从任何同时携带 code+name 的响应里学习（robots 列表/快照等），在每次轮询后调用。 */
export function rememberRobotNames(rows: NameCarrier[] | null | undefined) {
  if (!rows) return
  for (const r of rows) {
    if (r?.robot_code && r?.robot_name && r.robot_name !== r.robot_code) {
      knownNames.set(r.robot_code, r.robot_name)
    }
  }
}

/** 显示名：上次已知名字 > 编码（永不返回空）。 */
export function robotDisplayName(code: string): string {
  return knownNames.get(code) || code
}
