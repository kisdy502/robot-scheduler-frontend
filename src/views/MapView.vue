<template>
  <div class="map-view">
    <div ref="canvasRef" class="map-canvas" />

    <!-- 顶部工具栏 -->
    <div class="map-toolbar">
      <el-button-group>
        <el-button size="small" :type="preset === 'top' ? 'primary' : ''" @click="setPreset('top')">俯视</el-button>
        <el-button size="small" :type="preset === 'tilt' ? 'primary' : ''" @click="setPreset('tilt')">斜视</el-button>
        <el-button size="small" :type="preset === 'side' ? 'primary' : ''" @click="setPreset('side')">侧视</el-button>
      </el-button-group>
      <el-button size="small" @click="fitView" style="margin-left:8px">全图</el-button>
      <el-divider direction="vertical" />
      <span class="route-toggle-label">全部路线</span>
      <el-switch v-model="showAllRoutes" size="small" @change="refreshRoutes" />
      <el-tag v-if="selectedRobot" closable size="small" style="margin-left:8px" @close="clearSelection">
        聚焦 {{ robotShortName(selectedRobot) }}
      </el-tag>
    </div>

    <!-- 右上信息（可折叠） -->
    <div class="map-overlay">
      <el-popover placement="left" :width="160" trigger="click">
        <template #reference>
          <el-button size="small" circle>
            <el-icon><InfoFilled /></el-icon>
          </el-button>
        </template>
        <div class="info-row"><span>地图</span><b>{{ mapName || '未加载' }}</b></div>
        <div class="info-row"><span>版本</span><b>{{ mapVersion || '--' }}</b></div>
        <div class="info-row"><span>机器人</span><b>{{ onlineCount }}/{{ robotCount }} 在线</b></div>
        <div class="info-row"><span>忙</span><b>{{ busyCount }} 台</b></div>
        <div class="info-row"><span>更新</span><b>{{ lastUpdate }}</b></div>
      </el-popover>
    </div>

    <!-- 右键菜单 -->
    <teleport to="body">
      <div v-if="ctxMenu.visible" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
           @click.stop>
        <div class="ctx-menu-header">{{ ctxMenu.point?.name }} ({{ ctxMenu.point?.id }})</div>
        <template v-if="ctxMenu.point?.type === 'workstation'">
          <div class="ctx-menu-item" @click="openDispatch('quality_inspection')">发起质检任务</div>
        </template>
        <template v-if="ctxMenu.point?.type === 'charge'">
          <div class="ctx-menu-item" @click="openDispatch('charge')">前往充电</div>
        </template>
        <template v-if="ctxMenu.point?.type === 'parking'">
          <div class="ctx-menu-item" @click="openDispatch('return_home')">前往归巢休息</div>
        </template>
        <div class="ctx-menu-item" @click="openDispatch('go_to_place')">移动到此点</div>
      </div>
    </teleport>

    <!-- 任务下发对话框（选机器人） -->
    <el-dialog
      v-model="dispatchDlg.visible"
      :title="`${zhType(dispatchDlg.taskType)} → ${dispatchDlg.point?.name || dispatchDlg.point?.id || ''}`"
      width="520px"
      align-center
    >
      <div class="dlg-tip">
        不选择机器人则由调度自动分配（按 ETA + 电量 + 状态评分择优，分配结果会弹出提示）；
        选择指定机器人则直接下发执行。
      </div>
      <el-radio-group v-model="dispatchDlg.selected" class="dlg-radios">
        <el-radio value="" border class="dlg-radio auto">
          <span class="robot-name">自动分配</span>
          <span class="robot-meta">调度评分择优</span>
        </el-radio>
        <el-radio
          v-for="r in dispatchDlg.candidates"
          :key="r.robot_code"
          :value="r.robot_code"
          border
          class="dlg-radio"
          :disabled="!canDispatch(r)"
        >
          <span class="robot-name">{{ r.robot_name || r.robot_code }}</span>
          <span class="robot-meta">
            {{ r.robot_code }} · 电量 {{ r.battery != null ? r.battery + '%' : '未知' }} ·
            {{ zhMode(r.mode) }}{{ canDispatch(r) ? '' : '（不可派）' }}
          </span>
        </el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="dispatchDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dispatchDlg.submitting" @click="confirmDispatch">
          {{ dispatchDlg.selected ? '直接下发' : '自动分配下发' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, h } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { MapCanvas } from '@/three/MapCanvas'
import type { PickedPoint } from '@/three/MapCanvas'
import { schedulerApi } from '@/api/scheduler'
import axios from 'axios'
import { rememberRobotNames } from '@/utils/robotNames'
import type { Waypoint, PathInfo, Zone, RobotInfo, ActiveRoute } from '@/types'

const canvasRef = ref<HTMLElement>()
let canvas: MapCanvas | null = null
let timer: ReturnType<typeof setInterval> | null = null
let clickOutsideHandler: (() => void) | null = null

const mapName = ref('')
const mapVersion = ref('')
const robots = ref<RobotInfo[]>([])
const routes = ref<ActiveRoute[]>([])
const selectedRobot = ref('')
const showAllRoutes = ref(true)
const lastUpdate = ref('')
const preset = ref('tilt')

const robotCount = computed(() => robots.value.length)
const onlineCount = computed(() => robots.value.filter(r => r.online_status === 'online').length)
const busyCount = computed(() => robots.value.filter(r => r.mode === 'running' || r.mode === 'charging').length)

// 右键菜单状态
const ctxMenu = reactive({ visible: false, x: 0, y: 0, point: null as PickedPoint | null })

function setPreset(p: 'top' | 'tilt' | 'side') { preset.value = p; canvas?.setPreset(p) }
function fitView() { canvas?.fitView() }

function hideCtxMenu() { ctxMenu.visible = false }

function showCtxMenu(point: PickedPoint, clientX: number, clientY: number) {
  ctxMenu.point = point
  ctxMenu.x = clientX
  ctxMenu.y = clientY
  ctxMenu.visible = true
}

/** 任务下发对话框：候选机器人 + 自动分配选项 */
const dispatchDlg = reactive({
  visible: false,
  submitting: false,
  taskType: '',
  point: null as PickedPoint | null,
  selected: '',
  candidates: [] as RobotInfo[],
})

const canDispatch = (r: RobotInfo) =>
  r.online_status === 'online' && r.mode === 'idle' && r.dispatchable

const zhMode = (m: string) => {
  const map: Record<string, string> = { idle: '空闲', running: '执行中', charging: '充电中', offline: '离线' }
  return map[m] ?? m
}

/** 右键菜单入口：打开选机器人对话框 */
function openDispatch(taskType: string) {
  const point = ctxMenu.point
  if (!point) return
  hideCtxMenu()
  dispatchDlg.taskType = taskType
  dispatchDlg.point = point
  dispatchDlg.selected = ''
  dispatchDlg.candidates = robots.value.filter(r => r.online_status === 'online')
  dispatchDlg.visible = true
  if (dispatchDlg.candidates.length === 0) {
    ElMessage.warning('当前无在线机器人')
  }
}

/** 对话框确认：指定机器人直接下发；不选走自动分配（下发后后台轮询评分结果） */
async function confirmDispatch() {
  const point = dispatchDlg.point
  if (!point) return
  dispatchDlg.submitting = true
  try {
    if (dispatchDlg.selected) {
      await dispatchToRobot(dispatchDlg.taskType, point, dispatchDlg.selected)
    } else {
      // 只 await 下发动作（POST），分配结果轮询放后台——不阻塞 submitting，
      // 否则第二次下发要等上一次 20s 轮询结束才能操作
      const reqId = await dispatchAutoSubmit(dispatchDlg.taskType, point)
      if (reqId) {
        pollAssignment(reqId, dispatchDlg.taskType, point)
      }
    }
  } finally {
    dispatchDlg.submitting = false
  }
}

/** 手动下发的任务模板 code（机器人侧按模板 code 执行 start-activity，非固定类型）：
 *  充电模板 code 随平台创建的模板变化，可用 VITE_CHARGE_TEMPLATE_CODE 环境变量覆盖 */
const CHARGE_TEMPLATE_CODE = (import.meta.env.VITE_CHARGE_TEMPLATE_CODE as string | undefined) ?? 'back-charge'
const QC_TEMPLATE_CODE = (import.meta.env.VITE_QC_TEMPLATE_CODE as string | undefined) ?? 'QC_CONTEXT'

function templateCodeOf(taskType: string): string | undefined {
  if (taskType === 'charge') return CHARGE_TEMPLATE_CODE
  if (taskType === 'quality_inspection') return QC_TEMPLATE_CODE
  return undefined
}

/** 指定机器人直接下发 */
async function dispatchToRobot(taskType: string, point: PickedPoint, robotCode: string) {
  const body: Record<string, unknown> = {
    taskflow_id: `tf-ctx-${Date.now()}`,
    task_id: `ctx-${taskType}-${Date.now()}`,
    task_template_type: taskType,
    task_template_code: templateCodeOf(taskType),
    nav_end_point: point.id,
    robot_code: robotCode,
    end_action: 'standby',
  }
  if (taskType === 'quality_inspection') {
    body.parameters = { task_template_code: templateCodeOf(taskType) }
  }
  try {
    const res = await axios.post('/api/v1/scheduler/dispatch_task', body, {
      headers: { 'Content-Type': 'application/json' },
    })
    const d = res.data
    if (d.status !== 0) {
      ElMessage.error(`下发失败: ${d.msg ?? d.detail ?? '未知错误'}`)
      return
    }
    const name = robots.value.find(r => r.robot_code === robotCode)?.robot_name ?? robotCode
    ElMessage.success(`已指派 ${name}（${robotCode}）执行${zhType(taskType)} → ${point.name || point.id}`)
    dispatchDlg.visible = false
  } catch (e: any) {
    ElMessage.error(`下发失败: ${e?.response?.data?.detail ?? e?.message ?? '网络错误'}`)
  }
}

/** 自动分配：下发（POST），成功即关对话框并返回请求 ID */
async function dispatchAutoSubmit(taskType: string, point: PickedPoint): Promise<string | null> {
  const body: Record<string, unknown> = {
    taskflow_id: `tf-ctx-${Date.now()}`,
    task_id: `ctx-${taskType}-${Date.now()}`,
    task_template_type: taskType,
    task_template_code: templateCodeOf(taskType),
    nav_end_point: point.id,
    end_action: 'standby',
  }
  if (taskType === 'quality_inspection') {
    body.parameters = { task_template_code: templateCodeOf(taskType) }
  }
  try {
    const res = await axios.post('/api/v1/scheduler/dispatch_task', body, {
      headers: { 'Content-Type': 'application/json' },
    })
    const d = res.data
    if (d.status !== 0) {
      ElMessage.error(`下发失败: ${d.msg ?? d.detail ?? '未知错误'}`)
      return null
    }
    ElMessage.info(`已下发${zhType(taskType)} → ${point.name || point.id}，等待调度分配...`)
    dispatchDlg.visible = false
    return d.data?.scheduler_request_id
  } catch (e: any) {
    ElMessage.error(`下发失败: ${e?.response?.data?.detail ?? e?.message ?? '网络错误'}`)
    return null
  }
}

/** 后台轮询分配结果（不阻塞操作；最多 20 秒），分配完成弹评分卡片 */
async function pollAssignment(reqId: string, taskType: string, point: PickedPoint) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const res = await axios.get(`/api/v1/scheduler/tasks/status?scheduler_request_id=${reqId}`)
      const d = res.data?.data
      if (!d) continue

      if (d.robot_code && (d.assignment_trace || d.rmf_task_id)) {
        showAssignmentCard(taskType, point, d.robot_code, d.assignment_summary, d.assignment_trace)
        return
      }
      if (d.execution_final) {
        ElMessage.error(`${zhType(taskType)} ${point.name || point.id}: ${d.message ?? '任务已结束'}`)
        return
      }
    } catch { /* 继续轮询 */ }
  }
  ElMessage.warning(`任务仍在排队中，可在任务历史页查看（请求 ID: ${reqId.substring(0, 8)}）`)
}

/** 分配结果通知：摘要 + 评分表（ETA/电量惩罚/总分） */
function showAssignmentCard(taskType: string, point: PickedPoint, robotCode: string,
                            summary: string, trace: any[]) {
  const robot = robots.value.find(r => r.robot_code === robotCode)
  const robotName = robot?.robot_name ?? robotCode

  const rows = (trace ?? []).map((c: any) => ({
    name: c.robot_name || c.robot_code,
    eta: c.eta_seconds,
    battery: c.battery_percent,
    penalty: c.battery_penalty_seconds,
    total: c.total_cost,
    selected: c.selected,
  }))

  ElNotification({
    title: `${zhType(taskType)} → ${point.name || point.id}，已分配 ${robotName}`,
    message: h('div', { class: 'assign-card' }, [
      h('div', { class: 'assign-summary' },
        summary || `已分配给 ${robotName}（${robotCode}）`),
      rows.length > 0 && h('table', { class: 'assign-table' }, [
        h('thead', null, h('tr', null, [
          h('th', null, '机器人'), h('th', null, 'ETA(s)'), h('th', null, '电量'),
          h('th', null, '电量惩罚'), h('th', null, '总分'),
        ])),
        h('tbody', null, rows.map(r => h('tr', { class: r.selected ? 'winner' : '' }, [
          h('td', { class: 'c-name' }, r.selected ? `★ ${r.name}` : r.name),
          h('td', { class: 'c-num' }, r.eta),
          h('td', { class: 'c-num' }, r.battery != null && r.battery >= 0 ? r.battery + '%' : '未知'),
          h('td', { class: 'c-num' }, r.penalty),
          h('td', { class: 'c-num' }, h('b', null, r.total)),
        ]))),
      ]),
    ]),
    type: 'success',
    duration: 10000,
    position: 'bottom-right',
    customClass: 'assign-notify',
  })
}

const zhType = (t: string) => {
  const m: Record<string, string> = {
    quality_inspection: '质检任务', charge: '充电任务', return_home: '归巢任务', go_to_place: '移动任务',
  }
  return m[t] ?? t
}

async function loadMap() {
  try {
    let waypoints: Waypoint[] = []
    let paths: PathInfo[] = []
    let zones: Zone[] = []
    let name = ''
    let version = ''

    try {
      const detail = await schedulerApi.mapDetail()
      if (detail?.loaded && detail.floors?.length > 0) {
        name = detail.map_name ?? ''
        version = detail.version ?? ''
        const floor = detail.floors[0]
        waypoints = (floor.waypoints ?? []).map((w: any) => ({
          id: String(w.id), name: String(w.name ?? w.id), floor_id: String(floor.floor_id ?? ''),
          x: Number(w.x), y: Number(w.y), theta: Number(w.theta ?? 0), type: String(w.type ?? 'path'),
        }))
        paths = (floor.paths ?? []).map((p: any) => ({
          id: String(p.id), from: String(p.from), to: String(p.to), waypoints: p.waypoints ?? [],
          bidirectional: p.bidirectional !== false,
          segments: (p.segments ?? []).map((s: any) => ({
            seq: Number(s.seq ?? 0), from: String(s.from ?? ''), to: String(s.to ?? ''),
            segment_type: String(s.segment_type ?? 'LINE'), control_points: s.control_points ?? null,
            back_up: Boolean(s.back_up), reverse: Boolean(s.reverse),
          })),
        }))
        zones = (floor.zones ?? []).map((z: any) => ({
          id: String(z.id), name: String(z.name ?? z.id), type: String(z.type ?? ''),
          maxSpeed: z.max_speed ?? null, vertices: z.vertices ?? [],
        }))
      }
    } catch { /* 回退 */ }

    if (waypoints.length === 0) {
      const wps = await schedulerApi.mapWaypoints() as any[]
      const current = await schedulerApi.mapCurrent()
      name = current?.map_name ?? ''
      version = current?.version ?? ''
      waypoints = (wps || []).map((w: any) => ({
        id: String(w.id), name: String(w.name ?? w.id), floor_id: String(w.floor_id ?? ''),
        x: Number(w.x), y: Number(w.y), theta: Number(w.theta ?? 0), type: String(w.type ?? 'path'),
      }))
    }

    mapName.value = name
    mapVersion.value = version
    canvas?.updateMap({ waypoints, paths, zones })
    lastUpdate.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) { console.warn('地图加载失败', e) }
}

async function loadMapImage() {
  try {
    const geo = await schedulerApi.mapGeo()
    if (geo?.loaded && geo.resolution && geo.width && geo.height) {
      await canvas?.loadMapImage('/api/v1/maps/current/image', geo)
    }
  } catch { /* 图片不可用 */ }
}

async function pollRobots() {
  try {
    const [robotList, routeList] = await Promise.all([
      schedulerApi.robots(),
      schedulerApi.activeRoutes().catch(() => [] as ActiveRoute[]),
    ])
    robots.value = robotList
    rememberRobotNames(robotList)
    routes.value = routeList
    canvas?.updateRobots(robots.value, selectedRobot.value)
    canvas?.updateRoutes(routes.value, selectedRobot.value, showAllRoutes.value)
    lastUpdate.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch { /* */ }
}

/** 选中状态变化即时刷新画布（不等下一轮轮询） */
function refreshRoutes() {
  canvas?.updateRobots(robots.value, selectedRobot.value)
  canvas?.updateRoutes(routes.value, selectedRobot.value, showAllRoutes.value)
}

function onRobotClicked(code: string) {
  selectedRobot.value = selectedRobot.value === code ? '' : code
  refreshRoutes()
}

function clearSelection() {
  selectedRobot.value = ''
  refreshRoutes()
}

function robotShortName(code: string) {
  return robots.value.find(r => r.robot_code === code)?.robot_name || code
}

onMounted(() => {
  if (canvasRef.value) {
    canvas = new MapCanvas(canvasRef.value)
    canvas.onPresetChange = (p) => { preset.value = p }
    canvas.onPointContextMenu = showCtxMenu
    canvas.onRobotClick = onRobotClicked
    loadMap()
    loadMapImage()
    pollRobots()
    timer = setInterval(pollRobots, 1000)
    clickOutsideHandler = hideCtxMenu
    document.addEventListener('click', clickOutsideHandler)
  }
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (clickOutsideHandler) document.removeEventListener('click', clickOutsideHandler)
  canvas?.dispose()
  canvas = null
})
</script>

<style scoped>
.map-view { position: relative; height: calc(100vh - 24px); }
.map-canvas { width: 100%; height: 100%; overflow: hidden; border-radius: 6px; background: #f5f7fa; }
.map-toolbar { position: absolute; top: 12px; left: 12px; z-index: 10; display: flex; align-items: center; }
.route-toggle-label { font-size: 12px; color: #606266; margin-right: 6px; }
.map-overlay { position: absolute; top: 12px; right: 12px; z-index: 10; }
.info-row { display: flex; justify-content: space-between; font-size: 12px; color: #606266; margin-bottom: 4px; }
.info-row b { color: #303133; font-weight: 500; }

/* 右键菜单 */
.ctx-menu {
  position: fixed; z-index: 9999; min-width: 160px;
  background: #fff; border: 1px solid #e4e7ed; border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding: 4px 0;
}
.ctx-menu-header {
  padding: 6px 14px; font-size: 12px; font-weight: 600; color: #909399;
  border-bottom: 1px solid #f0f0f0; margin-bottom: 4px;
}
.ctx-menu-item {
  padding: 7px 14px; font-size: 13px; color: #303133; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.ctx-menu-item:hover { background: #ecf5ff; color: #409eff; }

/* 任务下发对话框 */
.dlg-tip {
  font-size: 12px; color: #909399; line-height: 1.6;
  background: #f5f7fa; border-radius: 4px; padding: 8px 12px; margin-bottom: 12px;
}
.dlg-radios { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dlg-radio { margin: 0; width: 100%; height: auto; padding: 8px 12px; }
.dlg-radio :deep(.el-radio__label) { display: flex; flex-direction: column; gap: 2px; white-space: normal; }
.dlg-radio.auto { border-color: #409eff; }
.robot-name { font-size: 13px; font-weight: 500; color: #303133; }
.robot-meta { font-size: 11px; color: #909399; }

/* 分配评分通知卡片 */
.el-notification.assign-notify { width: 470px; }
.assign-card { max-width: 440px; }
.assign-summary {
  font-size: 12px; color: #606266; margin-bottom: 8px; line-height: 1.5;
  background: #f5f7fa; border-radius: 4px; padding: 6px 10px;
}
.assign-table { border-collapse: collapse; font-size: 12px; width: 100%; table-layout: fixed; }
.assign-table th, .assign-table td {
  border: 1px solid #ebeef5; padding: 4px 8px; text-align: center; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.assign-table th { background: #f5f7fa; color: #606266; font-weight: 500; }
.assign-table td.c-num { font-family: Consolas, monospace; }
.assign-table td.c-name { text-align: left; }
.assign-table tr.winner td { background: #f0f9eb; color: #67c23a; font-weight: 600; }
</style>
