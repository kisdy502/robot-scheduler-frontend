/** 调度系统 API 类型定义（对齐后端 /api/v1/observability/* 与 /api/v1/runtime/* 响应） */

export interface Waypoint {
  id: string
  name: string
  floor_id: string
  x: number
  y: number
  theta: number
  type: string
}

export interface PathSegment {
  seq: number
  from: string
  to: string
  segment_type: string
  control_points: number[][] | null
  back_up: boolean
  reverse: boolean
}

export interface PathInfo {
  id: string
  from: string
  to: string
  waypoints: string[]
  bidirectional: boolean
  segments: PathSegment[]
}

export interface Zone {
  id: string
  name: string
  type: string
  maxSpeed: number | null
  vertices: number[][]
}

export interface MapFloor {
  floorId: string
  name: string
  elevation: number
  defaultMaxSpeed: number
  waypoints: Waypoint[]
  paths: PathInfo[]
  zones: Zone[]
}

export interface MapMetadata {
  versionInfo: { version: string; status: string; lastModified: string; modifiedBy: string }
  mapName: string
  floors: MapFloor[]
}

export interface RobotInfo {
  robot_code: string
  robot_name: string
  fleet_name: string
  scene_code: string | null
  rmf_level: string
  online_status: 'online' | 'offline'
  mode: string
  dispatchable: boolean
  decommissioned?: boolean
  battery: number | null
  home_point: string | null
  current_point: string | null
  target_point: string | null
  current_map: string
  pose: { x: number; y: number; yaw: number; level_name: string; index: number } | null
  compatible_chargers: string[]
  assigned_charger_id: string | null
  current_task_id: string | null
  rmf_task_id: string | null
  task_status: string | null
  updated_at: number
}

export interface TaskRecord {
  rmf_task_id: string
  business_task_id: string
  robot_code: string
  category: string
  status: string
  message: string | null
  inspection_result: Record<string, unknown> | null
  cancellation: Record<string, unknown> | null
  detail: Record<string, unknown> | null
  request_payload?: Record<string, unknown> | null
  updated_at: number | null
}

export interface ChargerInfo {
  charger_id: string
  name: string
  resource_type: string
  rmf_level: string
  waypoint: string
  status: number
  occupied_by: string | null
  enabled: boolean
  updated_at: number
}

export interface ActiveRoutePoint {
  id: string
  x: number | null
  y: number | null
}

/** 机器人活动路线（当前任务规划途经点序列） */
export interface ActiveRoute {
  robot_code: string
  task_id: string
  floor_id: string
  progress: number
  total: number
  waypoints: ActiveRoutePoint[]
  updated_at: number
}

export interface OccupationSnapshot {
  occupied_segments: string[]
  occupied_waypoints: string[]
  by_robot: Record<string, { segment_ids: string[]; waypoint_ids: string[]; acquired_atMillis: number }>
}

export interface TrafficEvent {
  id: string
  robot_code: string
  action: string
  resource_id: string | null
  detail: { message?: string } | null
  created_at: number | null
}

/** 机器人事件（K8s Events 风格聚合） */
export interface RobotEvent {
  id: string
  robot_code: string
  event_type: 'MODE' | 'BATTERY' | 'ONLINE' | string
  reason: string
  severity: 'INFO' | 'WARN' | 'ERROR' | string
  old_value: string | null
  new_value: string | null
  message: string | null
  count: number
  first_at: number | null
  last_at: number | null
}
