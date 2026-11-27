import axios from 'axios'
import type {
  MapMetadata, RobotInfo, TaskRecord, ChargerInfo, TrafficEvent, ActiveRoute, RobotEvent,
} from '@/types'

const http = axios.create({ baseURL: '', timeout: 10000 })

// 调度 API 信封统一 { status, msg, data, timestamp } 或 { status, msg, data }
async function get<T>(url: string): Promise<T> {
  const res = await http.get(url)
  return res.data?.data ?? res.data
}

export const schedulerApi = {
  /** 地图地理信息（origin/resolution/尺寸，定位背景图） */
  mapGeo(): Promise<any> {
    return get('/api/v1/maps/current/geo')
  },

  /** 地图图片 URL（直接 img src 用） */
  get mapImageUrl() { return '/api/v1/maps/current/image' },

  /** 地图完整详情（含路径/区域，前端地图渲染数据源） */
  mapDetail(): Promise<any> {
    return get('/api/v1/maps/current/detail')
  },

  /** 地图摘要 */
  mapCurrent(): Promise<{ loaded: boolean; map_name?: string; version?: string }> {
    return get('/api/v1/maps/current')
  },
  mapWaypoints(floorId?: string, type?: string): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams()
    if (floorId) params.set('floor_id', floorId)
    if (type) params.set('type', type)
    const q = params.toString()
    return get(`/api/v1/maps/current/waypoints${q ? '?' + q : ''}`)
  },

  /** 上传地图包并激活切图（地图编辑器导出的 zip 整包直传，后端解包识别三件套）。
   *  失败抛错：HTTP 409 = 有任务绑定或交通占用，400 = 包格式/元数据非法，
   *  后端 Result 信封的 msg 在 error.response.data.msg */
  async uploadMapPackage(file: File): Promise<any> {
    const form = new FormData()
    form.append('package', file, file.name)
    const res = await http.post('/api/v1/maps/upload-package', form, { timeout: 120000 })
    if (res.data?.status !== 0) {
      throw new Error(res.data?.msg ?? '地图包上传失败')
    }
    return res.data?.data ?? res.data
  },

  /** 机器人实时 */
  robots(): Promise<RobotInfo[]> {
    return get('/api/v1/runtime/fleets/snapshot').then((d: any) => d.robots ?? [])
  },

  /** 活动路线（各机器人当前任务的规划途经点序列） */
  activeRoutes(): Promise<ActiveRoute[]> {
    return get('/api/v1/observability/routes')
  },

  /** 任务历史 */
  tasks(params: { robot_code?: string; status?: string; category?: string; page_num?: number; page_size?: number } = {}): Promise<{ list: TaskRecord[]; total: number }> {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)) })
    return get(`/api/v1/observability/tasks?${q.toString()}`)
  },

  /** 取消任务（旧契约：rmf_task_id 定位；排队→canceled，执行中→completed+cancellation） */
  async stopTask(rmfTaskId: string, reason = '手动取消'): Promise<unknown> {
    const res = await http.post('/api/v1/scheduler/stop-task', {
      rmf_task_id: rmfTaskId, reason,
    }, { headers: { 'Content-Type': 'application/json' } })
    return res.data?.data ?? res.data
  },

  /** 充电桩 */
  chargers(): Promise<ChargerInfo[]> {
    return get('/api/v1/observability/chargers')
  },

  /** 交通占用 */
  occupation(): Promise<{ occupied_segments: string[]; occupied_waypoints: string[]; by_robot: Record<string, any> }> {
    return get('/api/v1/observability/traffic/occupation')
  },

  /** 交通事件 */
  trafficEvents(params: { robot_code?: string; page_num?: number; page_size?: number } = {}): Promise<{ list: TrafficEvent[]; total: number }> {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)) })
    return get(`/api/v1/observability/traffic/events?${q.toString()}`)
  },

  /** 机器人事件日志（状态/电量/上下线） */
  robotEvents(params: { robot_code?: string; event_type?: string; severity?: string; page_num?: number; page_size?: number } = {}): Promise<{ list: RobotEvent[]; total: number }> {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)) })
    return get(`/api/v1/observability/robot-events?${q.toString()}`)
  },

  /** 任务流抢占机器人（上层应用语义：占住机器人做业务编排）。
   *  taskflow_id 为雪花 ID（64 位）；手工拼原始 JSON 以数字形式发送，
   *  避免 JS Number 2^53 精度丢失（axios+JSON.stringify 无法安全承载 19 位数字） */
  async assignRobot(taskflowId: string, robotCode: string): Promise<unknown> {
    if (!/^\d{1,19}$/.test(taskflowId)) {
      throw new Error(`taskflow_id 必须是纯数字雪花 ID: ${taskflowId}`)
    }
    const body = `{"taskflow_id":${taskflowId},` +
        `"task_template_type_list":["quality_inspection"],` +
        `"robot_code":${JSON.stringify(robotCode)}}`
    const res = await http.post('/api/v1/scheduler/assign-task', body, {
      headers: { 'Content-Type': 'application/json' },
    })
    return res.data?.data ?? res.data
  },

  /** 释放机器人（业务编排结束/失败都必须调用） */
  async releaseRobot(taskflowId: string, robotCode: string): Promise<unknown> {
    const res = await http.post('/api/v1/scheduler/release-robot', {
      taskflow_id: taskflowId, robot_code: robotCode,
    }, { headers: { 'Content-Type': 'application/json' } })
    return res.data?.data ?? res.data
  },

  /** 移动任务下发（goto-place：新版架构统一移动入口——调度只管移动，到位即完成；
   *  质检/充电等业务动作由上层应用直连 RMS start-activity） */
  async gotoPlace(taskflowId: string, taskId: string, robotCode: string, navTargetPoint: string,
                  parameters?: Record<string, unknown>): Promise<any> {
    const body: Record<string, unknown> = {
      taskflow_id: taskflowId,
      task_id: taskId,
      nav_target_point: navTargetPoint,
      robot_code: robotCode,
    }
    if (parameters) body.parameters = parameters
    const res = await http.post('/api/v1/scheduler/goto-place', body, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.data?.status !== 0) {
      throw new Error(res.data?.msg ?? res.data?.detail ?? 'goto-place failed')
    }
    return res.data?.data ?? res.data
  },

  /** 按业务任务 ID 查询调度任务状态（polished status） */
  taskStatus(taskId: string): Promise<any> {
    return get(`/api/v1/scheduler/tasks/${encodeURIComponent(taskId)}/status`)
  },

  /** 使用权心跳（租约续期：长外部作业期间定期调用，防孤儿回收误杀） */
  async ownershipHeartbeat(taskflowId: string): Promise<unknown> {
    const res = await http.post('/api/v1/scheduler/robot-use/heartbeat', { taskflow_id: taskflowId },
      { headers: { 'Content-Type': 'application/json' } })
    return res.data?.data ?? res.data
  },

  /** 强制释放机器人使用权（运维逃生门：有活动任务 409 提示先取消） */
  async forceReleaseRobot(robotCode: string, reason: string): Promise<any> {
    const res = await http.post('/api/v1/scheduler/force-release-robot', {
      robot_code: robotCode, reason,
    }, { headers: { 'Content-Type': 'application/json' } })
    return res.data?.data ?? res.data
  },

  /** 外部动作回执镜像（上层应用直连 RMS 的质检/夹爪动作结果，按 body_task_id 与移动任务聚合） */
  activities(params: { robot_code?: string; task_id?: string; page_num?: number; page_size?: number } = {}): Promise<{ list: any[]; total: number }> {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)) })
    return get(`/api/v1/observability/activities?${q.toString()}`)
  },
}

/** RMS 直连 API（模拟上层应用行为，经 vite /rms-api 代理；生产由上层服务端直连）。
 *  路径契约：RMF 命令类端点在 /api/v1/robot-management/rmf/** 下（与调度 rms-client BASE_PATH 一致）；
 *  管理类端点（机器人 CRUD）在 /api/v1/robot-management/**（无 /rmf 段） */
export const rmsApi = {
  /** 下发业务动作（质检等）：机器人在位后由上层应用直接触发 */
  async startActivity(robotCode: string, body: Record<string, unknown>): Promise<any> {
    const res = await http.post(
      `/rms-api/api/v1/robot-management/rmf/robots/${encodeURIComponent(robotCode)}/start-activity`,
      body, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
    if (res.data?.status !== 0) {
      throw new Error(res.data?.msg ?? `start-activity rejected: ${res.data?.data?.reject_reason ?? 'unknown'}`)
    }
    if (res.data?.data && res.data.data.accepted === false) {
      throw new Error(`start-activity rejected: ${res.data.data.reject_reason ?? res.data.data.message ?? 'unknown'}`)
    }
    return res.data?.data ?? res.data
  },

  /** 车队状态帧（含 completed_commands 回执信箱，质检结果从这里取） */
  fleetStatus(fleetName: string): Promise<any> {
    return get(`/rms-api/api/v1/robot-management/rmf/fleets/${encodeURIComponent(fleetName)}/status`)
  },

  /** 回执确认（清空信箱；上层应用读走结果后应答，防止信箱积压与重复投递） */
  async ackCompletion(robotCode: string, completionId: string): Promise<unknown> {
    const res = await http.post(
      `/rms-api/api/v1/robot-management/rmf/robots/${encodeURIComponent(robotCode)}/completions/${encodeURIComponent(completionId)}/ack`,
      null, { timeout: 10000 })
    return res.data
  },

  /** 业务模板下发（上层应用职责：start-activity 前先把模板推送到机器人本体，
   *  否则真机拒绝执行："任务模板未下发，请先通过 task_template/add 下发模板"）。
   *  注意：RMS 校验 template_file_URL 必填（需真实模板文件），当前流程模板由人工预置到容器，此方法仅备用 */
  async pushTaskTemplate(robotCodes: string[], templateCode: string, description?: string,
                         templateFileUrl?: string): Promise<any> {
    const body: Record<string, unknown> = {
      templateCode,
      template_description: description ?? `质检模拟模板 ${templateCode}`,
      robot_codes: robotCodes,
    }
    if (templateFileUrl) body.template_file_URL = templateFileUrl
    const res = await http.post('/rms-api/api/v1/robot-management/robots/body/task-template/add', body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
    if (res.data?.status !== 0) {
      throw new Error(`模板下发失败: ${res.data?.msg ?? '未知错误'}`)
    }
    return res.data?.data ?? res.data
  },

  /** 停止机器人本体任务（中止业务动作用；RMS 幂等：无活动任务/已终态也返回成功） */
  async stopBodyTask(robotCode: string, bodyTaskId: string, runningCmdId: number): Promise<any> {
    const res = await http.post(
      `/rms-api/api/v1/robot-management/rmf/robots/${encodeURIComponent(robotCode)}/stop`, {
        running_cmd_id: String(runningCmdId),
        stop_cmd_id: String(Date.now() % 1000000),
        body_task_id: bodyTaskId,
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
    return res.data
  },
}
