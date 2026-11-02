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
}
