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
      <el-divider direction="vertical" />
      <el-button size="small" @click="uploadDlg.visible = true">
        <el-icon style="margin-right:4px"><UploadFilled /></el-icon>切图
      </el-button>
      <el-tag v-if="selectedRobot" closable size="small" style="margin-left:8px" @close="clearSelection">
        聚焦 {{ robotShortName(selectedRobot) }}
      </el-tag>
    </div>

    <div class="active-routes">
      <div>活动路线（{{ routes.length }}）<span v-if="routeError"> · 路线读取失败，保留上次结果</span></div>
      <div v-if="!routes.length">暂无已取得交通资源的路线</div>
      <button v-for="r in routes" :key="r.robot_code" class="active-route" @click="onRobotClicked(r.robot_code)">
        <b>{{ robotShortName(r.robot_code) }}</b> · {{ r.task_id }}
        <div>{{ r.waypoints.map(p => p.id).join(' → ') }}</div>
        <small>已到达 {{ r.waypoints[r.progress]?.id || '--' }}</small>
      </button>
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

    <!-- 右键菜单（新版架构：调度只管移动，质检动作由"质检模拟"模块模拟上层应用下发） -->
    <teleport to="body">
      <div v-if="ctxMenu.visible" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
           @click.stop>
        <div class="ctx-menu-header">{{ ctxMenu.point?.name }} ({{ ctxMenu.point?.id }})</div>
        <template v-if="ctxMenu.point?.type === 'workstation'">
          <div class="ctx-menu-item" @click="openDispatch('quality_inspection')">移动到作业点</div>
        </template>
        <template v-if="ctxMenu.point?.type === 'charge'">
          <div class="ctx-menu-item" @click="openDispatch('charge')">移动到充电位</div>
        </template>
        <template v-if="ctxMenu.point?.type === 'parking'">
          <div class="ctx-menu-item" @click="openDispatch('return_home')">移动到归巢点</div>
        </template>
        <div class="ctx-menu-item" @click="openDispatch('go_to_place')">移动到此点</div>
      </div>
    </teleport>

    <!-- 移动任务对话框（新版架构：机器人选定下发，调度不做自动分配） -->
    <el-dialog
      v-model="dispatchDlg.visible"
      :title="`${zhType(dispatchDlg.taskType)} → ${dispatchDlg.point?.name || dispatchDlg.point?.id || ''}`"
      width="520px"
      align-center
    >
      <div class="dlg-tip">
        选定机器人直接下发移动任务（规划路径 → 导航到点 → 交通管制，到位即完成）。
      </div>
      <el-radio-group v-model="dispatchDlg.selected" class="dlg-radios">
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
        <el-button type="primary" :disabled="!dispatchDlg.selected" @click="confirmDispatch">
          下发移动（后台执行）
        </el-button>
      </template>
    </el-dialog>

    <!-- 切图对话框：上传地图编辑器导出的 zip 整包，后端解包识别并激活 -->
    <el-dialog v-model="uploadDlg.visible" title="上传地图包（切换激活地图）" width="480px" align-center
               :close-on-click-modal="false">
      <div class="dlg-tip">
        当前地图：<b>{{ mapName || '未加载' }}</b>{{ mapVersion ? ' · ' + mapVersion : '' }}
      </div>
      <div class="dlg-tip">
        上传地图编辑器导出的 zip 整包，校验通过后立即切换激活地图并重建规划图。
      </div>
      <div class="dlg-tip dlg-warn">
        切图前要求：无排队/执行中任务、机器人无驻留占用，否则被拒绝（409）；
        机器人侧请先部署新地图（包内 native 机器人包），否则地图不一致的任务会立即失败。
      </div>
      <el-upload drag accept=".zip" :auto-upload="false" :show-file-list="false" :on-change="onZipPicked">
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖拽地图包 zip 到此处，或<em>点击选择</em></div>
        <template #tip>
          <div class="el-upload__tip">自动识别包内 map_info.json + 地图图片 + SLAM yaml，其余文件忽略</div>
        </template>
      </el-upload>
      <div v-if="uploadDlg.file" class="picked-file">
        <el-icon><DocumentChecked /></el-icon>
        <span class="picked-name">{{ uploadDlg.file.name }}</span>
        <span class="picked-size">{{ (uploadDlg.file.size / 1024 / 1024).toFixed(1) }} MB</span>
        <el-button link type="danger" size="small" @click="uploadDlg.file = null">移除</el-button>
      </div>
      <template #footer>
        <el-button @click="uploadDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="uploadDlg.uploading" :disabled="!uploadDlg.file" @click="confirmUpload">
          上传并切换
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { MapCanvas } from '@/three/MapCanvas'
import type { PickedPoint } from '@/three/MapCanvas'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames } from '@/utils/robotNames'
import { useTheme } from '@/utils/theme'
import type { Waypoint, PathInfo, Zone, RobotInfo, ActiveRoute } from '@/types'

const canvasRef = ref<HTMLElement>()
let canvas: MapCanvas | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let polling = false
let stopped = true
let clickOutsideHandler: (() => void) | null = null

const mapName = ref('')
const mapVersion = ref('')
const robots = ref<RobotInfo[]>([])
const routes = ref<ActiveRoute[]>([])
const routeError = ref(false)
const selectedRobot = ref('')
const showAllRoutes = ref(true)
const lastUpdate = ref('')
const preset = ref('tilt')

const robotCount = computed(() => robots.value.length)
const onlineCount = computed(() => robots.value.filter(r => r.online_status === 'online').length)
const busyCount = computed(() => robots.value.filter(r => r.mode === 'running' || r.mode === 'charging').length)

// 右键菜单状态
const ctxMenu = reactive({ visible: false, x: 0, y: 0, point: null as PickedPoint | null })

const { isDark } = useTheme()

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

// 派发资格以后端 dispatchable 为准（离线/停止确认/地图不一致/使用权冲突均已在其中）；
// 不按 mode 过滤——充电中可打断离桩执行任务（后端观测离桩自动释放充电位）
const canDispatch = (r: RobotInfo) =>
  r.online_status === 'online' && r.dispatchable
  && !inFlightRobots.value.includes(r.robot_code)

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

/** 对话框确认：选定机器人后台执行移动业务流（抢占→移动→释放），立即关窗可继续给其他机器人下发 */
const inFlightRobots = ref<string[]>([])
async function confirmDispatch() {
  const point = dispatchDlg.point
  if (!point || !dispatchDlg.selected) return
  const robotCode = dispatchDlg.selected
  const taskType = dispatchDlg.taskType
  dispatchDlg.visible = false
  inFlightRobots.value.push(robotCode)
  const name = robots.value.find(r => r.robot_code === robotCode)?.robot_name ?? robotCode
  ElMessage.info(`已下发 ${name}（${robotCode}）${zhType(taskType)} → ${point.name || point.id}，后台执行中`)
  try {
    const { runMoveFlow } = await import('@/utils/moveFlow')
    const result = await runMoveFlow({
      robotCode, pointId: String(point.id),
      onEvent: (step, phase, text) => console.info(`[移动业务流 ${robotCode}] ${step} ${phase}: ${text}`),
    })
    ElMessage.success(`${name} 移动完成（任务 ${result.taskId}）`)
  } catch (e: any) {
    ElMessage.error(`${name} 移动失败: ${e?.message ?? '未知错误'}`)
  } finally {
    inFlightRobots.value = inFlightRobots.value.filter(c => c !== robotCode)
  }
}

const zhType = (t: string) => {
  const m: Record<string, string> = {
    quality_inspection: '移动到作业点', charge: '移动到充电位', return_home: '移动到归巢点', go_to_place: '移动任务',
  }
  return m[t] ?? t
}

/** 切图对话框状态 */
const uploadDlg = reactive({
  visible: false,
  uploading: false,
  file: null as File | null,
})

function onZipPicked(uploadFile: { raw?: File }) {
  uploadDlg.file = uploadFile.raw ?? null
}

/** 确认上传：成功后立即重载地图元数据与背景图（后端已清空旧路线与等待意图） */
async function confirmUpload() {
  const file = uploadDlg.file
  if (!file || uploadDlg.uploading) return
  uploadDlg.uploading = true
  try {
    const data = await schedulerApi.uploadMapPackage(file)
    uploadDlg.visible = false
    uploadDlg.file = null
    ElMessage.success(`地图已切换: ${data?.map_name ?? ''} ${data?.version ?? ''}`)
    routes.value = []
    await loadMap()
    await loadMapImage()
  } catch (e: any) {
    const msg = e?.response?.data?.msg ?? e?.message ?? '未知错误'
    ElMessage.error(`切图失败: ${msg}`)
  } finally {
    uploadDlg.uploading = false
  }
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
      // 切图后同名 URL 命中浏览器 30s 缓存会拿到旧底图，时间戳强制取新图
      await canvas?.loadMapImage(`/api/v1/maps/current/image?t=${Date.now()}`, geo)
    }
  } catch { /* 图片不可用 */ }
}

async function pollRobots() {
  if (stopped || polling || document.hidden) return
  polling = true
  try {
    const [robotList, routeList] = await Promise.all([
      schedulerApi.robots(),
      schedulerApi.activeRoutes().then(list => { routeError.value = false; return list })
        .catch(() => { routeError.value = true; return null }),
    ])
    if (stopped) return
    robots.value = robotList
    rememberRobotNames(robotList)
    // 路线接口暂时失败时保留上一帧，不反复清空、重建路线造成闪烁。
    if (routeList) routes.value = routeList
    canvas?.updateRobots(robots.value, selectedRobot.value)
    canvas?.updateRoutes(routes.value, selectedRobot.value, showAllRoutes.value)
    lastUpdate.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch { /* 保留上一帧，下一轮恢复 */ }
  finally {
    polling = false
    // 请求完成后再安排下一次，慢请求不会重叠，也不会被旧响应覆盖。
    if (!stopped && !document.hidden) timer = setTimeout(pollRobots, 1000)
  }
}

function onVisibilityChange() {
  if (timer) { clearTimeout(timer); timer = null }
  if (!document.hidden) void pollRobots()
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
    canvas.setTheme(isDark.value)
    watch(isDark, v => canvas?.setTheme(v))
    stopped = false
    canvas.onPresetChange = (p) => { preset.value = p }
    canvas.onPointContextMenu = showCtxMenu
    canvas.onRobotClick = onRobotClicked
    loadMap()
    loadMapImage()
    pollRobots()
    document.addEventListener('visibilitychange', onVisibilityChange)
    clickOutsideHandler = hideCtxMenu
    document.addEventListener('click', clickOutsideHandler)
  }
})

onUnmounted(() => {
  stopped = true
  if (timer) clearTimeout(timer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (clickOutsideHandler) document.removeEventListener('click', clickOutsideHandler)
  canvas?.dispose()
  canvas = null
})
</script>

<style scoped>
.map-view { position: relative; height: calc(100vh - 24px); }
.active-routes { position: absolute; bottom: 12px; left: 12px; max-width: 480px; max-height: 28vh; overflow: auto; padding: 8px; border-radius: 6px; background: var(--rs-panel-bg); font-size: 12px; }
.active-route { display: block; width: 100%; padding: 6px 0; border: 0; border-top: 1px solid var(--rs-border-light); background: transparent; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.map-canvas { width: 100%; height: 100%; overflow: hidden; border-radius: 6px; background: var(--rs-bg-page); }
.map-toolbar { position: absolute; top: 12px; left: 12px; z-index: 10; display: flex; align-items: center; }
.route-toggle-label { font-size: 12px; color: var(--rs-text-2); margin-right: 6px; }
.map-overlay { position: absolute; top: 12px; right: 12px; z-index: 10; }
.info-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--rs-text-2); margin-bottom: 4px; }
.info-row b { color: var(--rs-text-1); font-weight: 500; }

/* 右键菜单 */
.ctx-menu {
  position: fixed; z-index: 9999; min-width: 160px;
  background: var(--rs-bg-card); border: 1px solid var(--rs-border); border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding: 4px 0;
}
.ctx-menu-header {
  padding: 6px 14px; font-size: 12px; font-weight: 600; color: var(--rs-text-3);
  border-bottom: 1px solid var(--rs-border-light); margin-bottom: 4px;
}
.ctx-menu-item {
  padding: 7px 14px; font-size: 13px; color: var(--rs-text-1); cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.ctx-menu-item:hover { background: var(--rs-hover-bg); color: #409eff; }

/* 任务下发对话框 */
.dlg-tip {
  font-size: 12px; color: var(--rs-text-3); line-height: 1.6;
  background: var(--rs-bg-soft); border-radius: 4px; padding: 8px 12px; margin-bottom: 12px;
}
.dlg-radios { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dlg-radio { margin: 0; width: 100%; height: auto; padding: 8px 12px; }
.dlg-radio :deep(.el-radio__label) { display: flex; flex-direction: column; gap: 2px; white-space: normal; }
.robot-name { font-size: 13px; font-weight: 500; color: var(--rs-text-1); }
.robot-meta { font-size: 11px; color: var(--rs-text-3); }

/* 切图对话框 */
.dlg-warn { color: var(--el-color-warning); }
.picked-file {
  display: flex; align-items: center; gap: 8px; margin-top: 10px;
  font-size: 12px; color: var(--rs-text-1);
  background: var(--rs-bg-soft); border-radius: 4px; padding: 6px 10px;
}
.picked-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picked-size { color: var(--rs-text-3); flex-shrink: 0; }
</style>
