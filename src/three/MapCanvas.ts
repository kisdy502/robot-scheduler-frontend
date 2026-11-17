/**
 * 地图 Three.js 画布：地图背景 + 点位/路径/区域/机器人 + 射线拾取 + 右键菜单回调。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { pointStyle } from '@/utils/pointStyle'
import { robotDisplayName } from '@/utils/robotNames'

import type { Waypoint, PathInfo, Zone, RobotInfo, ActiveRoute } from '@/types'

// ==================== 机器人徽标（紧凑单行：图标 + 名字 + 5 格电池） ====================

/** 状态图标映射：空闲 ○ / 移动 ➤ / 作业 ⚙ / 充电 ⚡ / 等待 … / 暂停 ‖ / 错误 ✕ / 离线 ⊘（label 供悬停说明） */
function modeIcon(mode: string): { glyph: string; color: string; label: string } {
  switch (mode) {
    case 'running': return { glyph: '➤', color: '#79bbff', label: '移动中（正在执行导航任务）' }
    case 'charging': return { glyph: '⚡', color: '#95d475', label: '充电中' }
    case 'working': return { glyph: '⚙', color: '#c8a6ff', label: '作业中（执行业务动作）' }
    case 'waiting': return { glyph: '…', color: '#eebe77', label: '等待中（交通/资源等待）' }
    case 'paused': return { glyph: '‖', color: '#eebe77', label: '已暂停' }
    case 'error': return { glyph: '✕', color: '#fab6b6', label: '异常（底盘报错）' }
    case 'offline': return { glyph: '⊘', color: '#a8abb2', label: '离线' }
    case 'idle':
    default: return { glyph: '○', color: '#a8abb2', label: '空闲' }
  }
}

/** 5 格电池条：满格数 = ceil(level/20)；<10% 红 / 10-20% 橙 / >20% 绿 */
function batteryBar(level: number | null | undefined): string {
  if (level == null || !Number.isFinite(level)) return ''
  const segs = Math.max(0, Math.min(5, Math.ceil(level / 20)))
  const cls = level < 10 ? 'r' : level <= 20 ? 'o' : 'g'
  let html = '<span class="nd-batt">'
  for (let i = 0; i < 5; i++) html += `<i class="${i < segs ? 'on ' + cls : ''}"></i>`
  return html + '</span>'
}

/** 名字截断：CJK 记 1 宽、其他记 0.5 宽，上限 6（"JY玄骨上人" 保留，"RB_20261103_..." 截短） */
function truncateCjkName(name: string, maxWidth = 6): string {
  let width = 0
  let end = 0
  for (const ch of name) {
    const w = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.5
    if (width + w > maxWidth) break
    width += w
    end += ch.length
  }
  return end < name.length ? name.slice(0, end) + '…' : name
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 徽标组装：[🔒]⚠图标 名字 电池条（🔒=使用权占用中） */
function buildRobotBadge(name: string, mode: string, battery: number | null | undefined,
                         anomalous: boolean, owned: boolean = false): string {
  const icon = modeIcon(mode)
  return (owned ? '<span class="nd-ricon nd-rlock">🔒</span>' : '')
      + (anomalous ? '<span class="nd-ricon" style="color:#fff">⚠</span>' : '')
      + `<span class="nd-ricon" style="color:${icon.color}">${icon.glyph}</span>`
      + `<b class="nd-rname">${escapeHtml(truncateCjkName(name))}</b>`
      + batteryBar(battery)
}
const POINT_R = 0.19
const POINT_H = 0.02
const LANE_W = 0.05
const LANE_H = 0.02
const ROBOT_L = 0.28
const ROBOT_W = 0.21
/** 画布主题配色（浅色值与 2D 视图/testDispatch 对齐；暗色整体加深一档增强对比） */
let darkTheme = false
let glyphColorHex = 0x52667a
let puckColorHex = 0x95d475
const GLYPH_COLOR_LIGHT = 0x52667a, GLYPH_COLOR_DARK = 0x2e3a48
const PUCK_COLOR_LIGHT = 0x95d475, PUCK_COLOR_DARK = 0x67c23a
const BG_LIGHT = 0xf5f7fa, BG_DARK = 0x0b0e13
const LANE_LIGHT = { color: 0x606266, opacity: 0.4 }, LANE_DARK = { color: 0x4a5568, opacity: 0.45 }
const CURVE_LIGHT = { color: 0x7a8fb5, opacity: 0.5 }, CURVE_DARK = { color: 0x5d729c, opacity: 0.5 }
const ARROW_LIGHT = { color: 0x7ab7ff, opacity: 0.7 }, ARROW_DARK = { color: 0xdfe9f5, opacity: 0.85 }

/** 机器人专属色板（图标/路线/终点环同色；按首次出现顺序分配，16 台内保证不撞色） */
const ROBOT_PALETTE = [0x409eff, 0x67c23a, 0xe6a23c, 0xf56c6c, 0x9b59b6,
  0x00b8d4, 0xff7043, 0x7cb342, 0xec407a, 0x5c6bc0,
  0x26a69a, 0xffca28, 0x8d6e63, 0xd4e157, 0xba68c8, 0x4fc3f7]

export interface MapGeoInfo {
  loaded: boolean
  resolution?: number
  width?: number
  height?: number
  origin_x?: number
  origin_y?: number
}

/** 射线拾取到的点位信息 */
export interface PickedPoint {
  id: string
  name: string
  type: string
  x: number
  y: number
}

type ViewPreset = 'top' | 'tilt' | 'side'

export class MapCanvas {
  private scene = new THREE.Scene()
  private camera!: THREE.PerspectiveCamera
  private renderer!: THREE.WebGLRenderer
  private labelRenderer!: CSS2DRenderer
  private controls!: OrbitControls
  private container: HTMLElement
  private resizeObs: ResizeObserver

  private pointsGroup = new THREE.Group()
  private pathsGroup = new THREE.Group()
  private zonesGroup = new THREE.Group()
  private robotsGroup = new THREE.Group()
  private routesGroup = new THREE.Group()
  private mapImageGroup = new THREE.Group()
  private gridGroup = new THREE.Group()
  private robots = new Map<string, RobotMesh>()
  /** waypointId → pointsGroup 中的 Group（射线拾取用） */
  private pointGroups = new Map<string, THREE.Group>()

  private cameraDistance = 35
  private currentPreset: ViewPreset = 'tilt'
  private sceneScale = 1
  private mapCenter = new THREE.Vector3(0, 0, 0)
  private raycaster = new THREE.Raycaster()
  private mouseNDC = new THREE.Vector2()

  /** 机器人配色分配（首次出现顺序取色板，16 台内保证互不相同；哈希取模会碰撞） */
  private robotColorAssign = new Map<string, number>()
  private nextColorIndex = 0

  private robotColor(code: string): number {
    let idx = this.robotColorAssign.get(code)
    if (idx === undefined) {
      idx = this.nextColorIndex % ROBOT_PALETTE.length
      this.nextColorIndex++
      this.robotColorAssign.set(code, idx)
    }
    return ROBOT_PALETTE[idx]
  }

  private animationId = 0
  private disposed = false
  private routesKey = ''

  /** 同一帧内的多次状态变更合并绘制；静止及后台页面不持续占用 GPU。 */
  private invalidate = () => {
    if (!this.disposed && !document.hidden && !this.animationId) {
      this.animationId = requestAnimationFrame(this.animate)
    }
  }

  private onVisibilityChange = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.animationId)
      this.animationId = 0
    } else {
      this.invalidate()
    }
  }

  // 回调
  onPointContextMenu: ((point: PickedPoint, clientX: number, clientY: number) => void) | null = null
  onPresetChange: ((preset: ViewPreset) => void) | null = null
  onRobotClick: ((robotCode: string) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.scene.background = new THREE.Color(0xf5f7fa)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    this.camera.position.set(0, -25, 25)
    // 场景为 XY 平面、Z 轴向上（栅格/点位/机器人布局约定）：
    // 必须显式 Z-up，否则 OrbitControls 按默认 Y-up 计算极角，俯仰被 maxPolarAngle 钳死
    this.camera.up.set(0, 0, 1)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    // 限制高分屏填充开销，避免 2~3 倍 DPR 导致 4~9 倍像素绘制。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.domElement.className = 'map-canvas-el'
    container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.setSize(container.clientWidth, container.clientHeight)
    this.labelRenderer.domElement.style.position = 'absolute'
    this.labelRenderer.domElement.style.top = '0'
    this.labelRenderer.domElement.style.left = '0'
    this.labelRenderer.domElement.style.pointerEvents = 'none'
    container.appendChild(this.labelRenderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.15
    this.controls.screenSpacePanning = true
    this.controls.minDistance = 2
    this.controls.maxDistance = 300
    // Z-up 语义：极角 = 俯仰（0 正俯视，π/2.05 近水平不让钻到地面下），方位角 = 左右旋转
    this.controls.minPolarAngle = 0.05
    this.controls.maxPolarAngle = Math.PI / 2.05
    this.controls.addEventListener('change', this.invalidate)
    document.addEventListener('visibilitychange', this.onVisibilityChange)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const dir = new THREE.DirectionalLight(0xffffff, 0.5)
    dir.position.set(10, 10, 30)
    this.scene.add(dir)

    this.scene.add(this.mapImageGroup, this.gridGroup, this.zonesGroup, this.pathsGroup, this.pointsGroup, this.routesGroup, this.robotsGroup)

    const grid = new THREE.GridHelper(80, 80, 0xd0d5dd, 0xe8ebf0)
    grid.rotation.x = Math.PI / 2
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.1
    this.gridGroup.add(grid)

    // 右键菜单 + 机器人点击选中（按下/抬起位移小于阈值判定为点击，避免拖拽旋转误触）
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu)
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp)

    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(container)
    this.setPreset('tilt')
  }

  /** 主题切换：底色/栅格/点位圆盘/朝向符号/车道/方向箭头重着色（CSS2D 标签走 --rs-* 变量自动切换） */
  setTheme(dark: boolean) {
    darkTheme = dark
    glyphColorHex = dark ? GLYPH_COLOR_DARK : GLYPH_COLOR_LIGHT
    puckColorHex = dark ? PUCK_COLOR_DARK : PUCK_COLOR_LIGHT
    this.scene.background = new THREE.Color(dark ? BG_DARK : BG_LIGHT)
    // 重建栅格（GridHelper 颜色烘焙在材质里，直接换新）
    for (const child of [...this.gridGroup.children]) {
      this.gridGroup.remove(child)
      const m = child as THREE.GridHelper
      m.geometry?.dispose()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach(x => x.dispose())
      else mat?.dispose()
    }
    const grid = new THREE.GridHelper(80, 80, dark ? 0x3a3f47 : 0xd0d5dd, dark ? 0x262a30 : 0xe8ebf0)
    grid.rotation.x = Math.PI / 2
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.1
    this.gridGroup.add(grid)
    // 已有点位：朝向扇形/类型符号 + 圆盘重着色（按两套主题已知色识别，不误伤 puck 主体色以外的材质）
    this.pointsGroup.traverse(obj => {
      const mat = ((obj as THREE.Mesh).material ?? null) as { color?: THREE.Color } | null
      const hex = mat?.color ? mat.color.getHex() : -1
      if (hex === GLYPH_COLOR_LIGHT || hex === GLYPH_COLOR_DARK) mat!.color!.setHex(glyphColorHex)
      else if (hex === PUCK_COLOR_LIGHT || hex === PUCK_COLOR_DARK) mat!.color!.setHex(puckColorHex)
    })
    // 车道条带/曲段/方向箭头：颜色 + 不透明度整体加深（材质共享，重复 set 无害）
    const lane = dark ? LANE_DARK : LANE_LIGHT
    const curve = dark ? CURVE_DARK : CURVE_LIGHT
    const arrow = dark ? ARROW_DARK : ARROW_LIGHT
    this.pathsGroup.traverse(obj => {
      const mat = ((obj as THREE.Mesh).material ?? null) as { color?: THREE.Color; opacity?: number } | null
      const hex = mat?.color ? mat.color.getHex() : -1
      if (hex === LANE_LIGHT.color || hex === LANE_DARK.color) {
        mat!.color!.setHex(lane.color); mat!.opacity = lane.opacity
      } else if (hex === CURVE_LIGHT.color || hex === CURVE_DARK.color) {
        mat!.color!.setHex(curve.color); mat!.opacity = curve.opacity
      } else if (hex === ARROW_LIGHT.color || hex === ARROW_DARK.color) {
        mat!.color!.setHex(arrow.color); mat!.opacity = arrow.opacity
      }
    })
    this.invalidate()
  }

  // ==================== 右键拾取 ====================

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouseNDC, this.camera)

    // 射线检测点位
    const pointMeshes: THREE.Object3D[] = []
    this.pointGroups.forEach((g) => pointMeshes.push(g))
    const hits = this.raycaster.intersectObjects(pointMeshes, true)
    if (hits.length > 0) {
      // 找到命中的点位 Group（向上找 userData.pick）
      let obj: THREE.Object3D | null = hits[0].object
      while (obj && !obj.userData?.pick) obj = obj.parent
      if (obj?.userData?.pick?.type === 'point') {
        this.onPointContextMenu?.(obj.userData.pick.data as PickedPoint, e.clientX, e.clientY)
        return
      }
    }
  }

  // ==================== 机器人点击选中 ====================

  private pointerDownAt: { x: number; y: number } | null = null
  private selectedPointId: string | null = null
  private selectionRing: THREE.Mesh | null = null

  /** 点位选中高亮：橙色线圈套在选中点圆盘外缘（传 null 取消选中；地图重建后自动恢复） */
  setSelectedPoint(id: string | null) {
    if (this.selectedPointId === id) return
    this.selectedPointId = id
    this.refreshSelectionRing()
    this.invalidate()
  }

  private refreshSelectionRing() {
    if (this.selectionRing) {
      this.selectionRing.removeFromParent()
      this.selectionRing.geometry.dispose()
      ;(this.selectionRing.material as THREE.Material).dispose()
      this.selectionRing = null
    }
    if (!this.selectedPointId) return
    const group = this.pointGroups.get(this.selectedPointId)
    if (!group) return
    // 立体线圈：带孔环形拉伸出微高度，套在点位圆盘外缘（与点位凸台同风格）
    const ringShape = new THREE.Shape()
    ringShape.absarc(0, 0, POINT_R * 1.16, 0, Math.PI * 2, false)
    const hole = new THREE.Path()
    hole.absarc(0, 0, POINT_R * 1.08, 0, Math.PI * 2, true)
    ringShape.holes.push(hole)
    const ring = new THREE.Mesh(
      new THREE.ExtrudeGeometry(ringShape, { depth: 0.012, bevelEnabled: false }),
      new THREE.MeshBasicMaterial({ color: 0xff9c3f, transparent: true, opacity: 0.95 }),
    )
    ring.position.z = POINT_H
    ring.renderOrder = 5
    group.add(ring)
    this.selectionRing = ring
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDownAt = { x: e.clientX, y: e.clientY }
  }

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDownAt
    this.pointerDownAt = null
    if (!down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
    if (e.button !== 0) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouseNDC, this.camera)
    const hits = this.raycaster.intersectObjects(this.robotsGroup.children, true)
    if (hits.length > 0) {
      let obj: THREE.Object3D | null = hits[0].object
      while (obj && !obj.userData?.robotCode) obj = obj.parent
      if (obj?.userData?.robotCode) {
        this.onRobotClick?.(obj.userData.robotCode as string)
        this.setSelectedPoint(null)
        return
      }
    }
    // 未命中机器人：尝试点位选中（命中选中并套橙色线圈，落空取消选中）
    const pointHits = this.raycaster.intersectObjects([...this.pointGroups.values()], true)
    if (pointHits.length > 0) {
      let obj: THREE.Object3D | null = pointHits[0].object
      while (obj && !obj.userData?.pick) obj = obj.parent
      if (obj?.userData?.pick?.type === 'point') {
        this.setSelectedPoint((obj.userData.pick.data as PickedPoint).id)
        return
      }
    }
    this.setSelectedPoint(null)
  }

  // ==================== 视角 ====================

  setPreset(preset: ViewPreset) {
    this.currentPreset = preset
    const d = this.cameraDistance
    const t = this.mapCenter
    switch (preset) {
      case 'top': this.camera.position.set(t.x, t.y, d); break
      case 'tilt': this.camera.position.set(t.x, t.y - d * 0.7, d * 0.7); break
      case 'side': this.camera.position.set(t.x, t.y - d, d * 0.2); break
    }
    this.camera.lookAt(t)
    this.controls.target.copy(t)
    this.controls.update()
    this.onPresetChange?.(preset)
    this.invalidate()
  }

  getPreset(): ViewPreset { return this.currentPreset }
  fitView() { this.setPreset(this.currentPreset) }

  // ==================== 地图背景图 ====================

  async loadMapImage(imageUrl: string, geo: MapGeoInfo) {
    if (!geo.loaded || !geo.resolution || !geo.width || !geo.height) return
    try {
      const loader = new THREE.TextureLoader()
      const texture = await loader.loadAsync(imageUrl)
      if (this.disposed) { texture.dispose(); return }
      texture.flipY = true
      const worldW = geo.width * geo.resolution
      const worldH = geo.height * geo.resolution
      const centerX = (geo.origin_x ?? 0) + worldW / 2
      const centerY = (geo.origin_y ?? 0) + worldH / 2
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(worldW, worldH),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      )
      plane.position.set(centerX, centerY, -0.01)
      this.clearGroup(this.mapImageGroup)
      this.mapImageGroup.add(plane)
      this.gridGroup.visible = false
      this.invalidate()
    } catch { /* 图片不可用 */ }
  }

  // ==================== 数据更新 ====================

  updateMap(data: { waypoints: Waypoint[]; paths: PathInfo[]; zones: Zone[] }) {
    if (this.disposed) return
    this.fitCamera(data.waypoints)
    this.rebuildPoints(data.waypoints)
    this.rebuildPaths(data.waypoints, data.paths)
    this.rebuildZones(data.zones)
    // 比例变化时，下次路线更新需重新生成目标环。
    this.routesKey = ''
    this.invalidate()
  }

  updateRobots(robots: RobotInfo[], selectedCode = '') {
    if (this.disposed) return
    const activeCodes = new Set<string>()
    let changed = false
    const now = performance.now()
    for (const r of robots) {
      if (!r.pose || !Number.isFinite(r.pose.x) || !Number.isFinite(r.pose.y)
          || !Number.isFinite(r.pose.yaw)) continue
      activeCodes.add(r.robot_code)
      let mesh = this.robots.get(r.robot_code)
      if (!mesh) {
        mesh = this.createRobotMesh(r.robot_code)
        this.robots.set(r.robot_code, mesh)
        this.robotsGroup.add(mesh.root)
        changed = true
      }
      const focused = r.robot_code === selectedCode
      if (!mesh.root.visible) { mesh.root.visible = true; changed = true }
      const scale = this.sceneScale * (focused ? 1.3 : 1)
      if (mesh.root.scale.x !== scale) { mesh.root.scale.setScalar(scale); changed = true }
      const target = { x: r.pose.x, y: r.pose.y, yaw: r.pose.yaw }
      if (!mesh.shown || r.online_status !== 'online') {
        mesh.root.position.set(target.x, target.y, 0)
        mesh.body.rotation.z = target.yaw
        changed ||= !mesh.shown || mesh.shown.x !== target.x || mesh.shown.y !== target.y
          || mesh.shown.yaw !== target.yaw || !!mesh.motion
        mesh.motion = null
      } else if (mesh.shown.x !== target.x || mesh.shown.y !== target.y || mesh.shown.yaw !== target.yaw) {
        // 只在展示层插值，不预测未来位置；新帧从当前显示姿态平滑过渡，角度取最短旋转。
        mesh.motion = { x: mesh.root.position.x, y: mesh.root.position.y,
          yaw: mesh.body.rotation.z, startedAt: now, target }
        changed = true
      }
      mesh.shown = target
      const el = mesh.label.element as HTMLDivElement
      const inner = el.querySelector('.nd-label-inner--robot') as HTMLSpanElement
      if (inner) {
        const displayName = robotDisplayName(r.robot_code)
        // 在线但不可派发（离图/异常模式/地图不一致）→ ⚠ 前缀 + 橙底，前端一眼可见（否则 mode=idle 看起来正常）
        const anomalous = r.online_status === 'online' && !r.dispatchable
        const badgeKey = JSON.stringify([displayName, r.mode, r.battery, anomalous, focused, r.online_status])
        if (badgeKey === mesh.badgeKey) continue
        mesh.badgeKey = badgeKey
        changed = true
        inner.innerHTML = buildRobotBadge(displayName, r.mode, r.battery, anomalous,
            r.owned_by_taskflow != null)
        inner.style.background = anomalous ? 'rgba(230,162,60,0.92)'
          : r.mode === 'running' ? 'rgba(64,158,255,0.85)'
          : r.mode === 'charging' ? 'rgba(103,194,58,0.85)'
          : r.mode === 'error' ? 'rgba(245,108,108,0.9)'
          : 'rgba(38,42,50,0.78)'
        inner.style.outline = focused ? '2px solid #409eff' : 'none'
        inner.classList.toggle('is-offline', r.online_status !== 'online')
      }
    }
    for (const [code, mesh] of this.robots) {
      if (!activeCodes.has(code)) {
        // 清单中移除的机器人不保留历史模型，反复上下线不会累积 GPU 对象。
        this.clearGroup(mesh.root)
        mesh.root.removeFromParent()
        this.robots.delete(code)
        changed = true
      }
    }
    if (changed) this.invalidate()
  }

  // ==================== 活动路线 ====================

  /**
   * 更新活动路线渲染：已走段灰色实心圆管、剩余段彩色虚线圆管、终点立体色环。
   * 立体化：点位/车道均有高度，平贴地面的像素线视觉上"陷下去"，统一改为有半径的圆管。
   */
  updateRoutes(routes: ActiveRoute[], selectedCode = '', showAll = true) {
    if (this.disposed) return
    const visibleRoutes = routes.filter(route => showAll || route.robot_code === selectedCode)
    // updated_at 等心跳字段不影响绘制，只有路线、进度和选中状态变化才重建。
    const key = JSON.stringify([selectedCode, this.sceneScale,
      visibleRoutes.map(route => [route.robot_code, route.progress,
        route.waypoints.map(point => [point.x, point.y])])])
    if (key === this.routesKey) return
    this.routesKey = key
    this.clearGroup(this.routesGroup)
    const scale = this.sceneScale
    for (const route of visibleRoutes) {
      const focused = route.robot_code === selectedCode
      if (!showAll && !focused) continue
      const pts = route.waypoints.filter(p => p.x != null && p.y != null)
      if (pts.length < 2) continue
      const color = this.robotColor(route.robot_code)
      // 车道条带顶面 0.02 之上（避免被立体条带遮挡/穿插）
      const z = focused ? 0.05 : 0.04

      // 已走段：灰色实心圆管（深一档保证可见：浅灰细线在浅底图上等同隐形）
      const cut = Math.min(route.progress, pts.length - 1)
      const traveled = pts.slice(0, cut + 1)
      const traveledR = focused ? 0.014 : 0.011
      if (traveled.length >= 2) {
        this.routesGroup.add(this.buildTube(traveled, z + traveledR, traveledR,
          new THREE.MeshBasicMaterial({ color: 0x7d8794, transparent: true, opacity: focused ? 0.6 : 0.45 })))
      }

      // 剩余段：彩色虚线圆管（聚焦提亮加粗）；dash 用固定世界米制——
      // 不能乘 sceneScale（大地图 scale≈3 时一段虚线 3.9m 比路段还长，视觉上退化为实线）
      const remaining = pts.slice(cut)
      const routeR = focused ? 0.022 : 0.017
      if (remaining.length >= 2) {
        const dashMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: focused ? 0.95 : 0.7 })
        for (const poly of this.sliceDashes(remaining, 0.6, 0.4)) {
          this.routesGroup.add(this.buildTube(poly, z + routeR, routeR, dashMat))
        }
      }

      // 终点立体色环（目标点标识，同机器人色；torus 平躺地面）
      const dest = pts[pts.length - 1]
      const tubeR = 0.035 * scale
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.22 * scale, tubeR, 10, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      )
      ring.position.set(dest.x!, dest.y!, z + tubeR)
      this.routesGroup.add(ring)
    }
    this.invalidate()
  }

  /** 沿折线的立体圆管（CurvePath 保留折角；z 为管底，管心抬半径件防穿车道） */
  private buildTube(poly: Array<{ x: number; y: number }>, zBottom: number, radius: number,
                    material: THREE.Material): THREE.Mesh {
    const path = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 0; i + 1 < poly.length; i++) {
      path.add(new THREE.LineCurve3(
        new THREE.Vector3(poly[i].x, poly[i].y, zBottom + radius),
        new THREE.Vector3(poly[i + 1].x, poly[i + 1].y, zBottom + radius)))
    }
    return new THREE.Mesh(
      new THREE.TubeGeometry(path, Math.max(poly.length * 8, 8), radius, 8, false), material)
  }

  /** 按世界米制把折线切成 dash/gap 交替的子折线（立体虚线管段用；保留折点处直角） */
  private sliceDashes(pts: ActiveRoute['waypoints'], dash: number, gap: number): Array<Array<{ x: number; y: number }>> {
    const cum: number[] = [0]
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x! - pts[i - 1].x!, pts[i].y! - pts[i - 1].y!))
    }
    const total = cum[cum.length - 1]
    if (total <= 0) return []
    const pointAt = (d: number) => {
      for (let i = 1; i < cum.length; i++) {
        if (d <= cum[i]) {
          const t = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9)
          return { x: pts[i - 1].x! + (pts[i].x! - pts[i - 1].x!) * t, y: pts[i - 1].y! + (pts[i].y! - pts[i - 1].y!) * t }
        }
      }
      return { x: pts[pts.length - 1].x!, y: pts[pts.length - 1].y! }
    }
    const polys: Array<Array<{ x: number; y: number }>> = []
    let start = 0
    while (start < total) {
      const end = Math.min(start + dash, total)
      const poly: Array<{ x: number; y: number }> = [pointAt(start)]
      for (let i = 1; i < pts.length - 1; i++) {
        if (cum[i] > start && cum[i] < end) poly.push({ x: pts[i].x!, y: pts[i].y! })
      }
      poly.push(pointAt(end))
      polys.push(poly)
      start = end + gap
    }
    return polys
  }

  // ==================== 点位构建 ====================

  private rebuildPoints(waypoints: Waypoint[]) {
    this.clearGroup(this.pointsGroup)
    this.pointGroups.clear()
    const scale = this.sceneScale

    for (const wp of waypoints) {
      const g = new THREE.Group()
      g.position.set(wp.x, wp.y, 0)
      g.scale.setScalar(scale)
      // 拾取数据（射线检测）
      g.userData.pick = {
        type: 'point',
        data: { id: wp.id, name: wp.name || wp.id, type: wp.type, x: wp.x, y: wp.y },
      }

      const style = pointStyle(wp.type)

      // 透明命中盘（仅射线拾取，不参与渲染）：material.visible=false 彻底跳过绘制——
      // 曾用 opacity:0 + transparent，部分环境仍渲染出浅灰正 12 边形（0.55 半径 = 绿盘 2.9 倍）
      const hit = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 12),
        new THREE.MeshBasicMaterial(),
      )
      hit.material.visible = false
      g.add(hit)

      // 立体圆盘（短圆柱凸台）：MeshBasic 不受光，浅色主题颜色与 2D 视图 #95d475 完全一致
      // （Lambert 受光会把浅绿压成深绿，立体感由圆柱侧壁轮廓体现即可）；暗色主题加深为标准绿
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(POINT_R, POINT_R, POINT_H, 28),
        new THREE.MeshBasicMaterial({ color: puckColorHex }),
      )
      puck.rotation.x = Math.PI / 2
      puck.position.z = POINT_H / 2
      g.add(puck)

      // 前半圆朝向扇形（随 theta 旋转，凸台顶面之上）
      const arrowShape = new THREE.Shape()
      arrowShape.absarc(0, 0, POINT_R * 0.75, -Math.PI / 3, Math.PI / 3, false)
      arrowShape.closePath()
      const arrow = new THREE.Mesh(
        new THREE.ShapeGeometry(arrowShape),
        new THREE.MeshBasicMaterial({ color: glyphColorHex, side: THREE.DoubleSide }),
      )
      arrow.position.z = POINT_H + 0.012
      const arrowGroup = new THREE.Group()
      arrowGroup.add(arrow)
      arrowGroup.rotation.z = wp.theta
      g.add(arrowGroup)

      // 后半圆类型符号（始终在箭头正后方：随 theta 同步旋转，凸台顶面之上。
      // 若固定世界 -x 方向，θ≈180° 的点箭头会扫过符号区，视觉上"图标跑到箭头那边"）
      if (style.outline.length > 0) {
        const shape = new THREE.Shape()
        const symbolScale = POINT_R * 0.45
        const symbolOffset = -POINT_R * 0.25 // 后移
        style.outline.forEach(([x, y], i) => {
          const px = (x * symbolScale) + symbolOffset
          const py = y * symbolScale
          if (i === 0) shape.moveTo(px, py)
          else shape.lineTo(px, py)
        })
        shape.closePath()
        const symbol = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({ color: glyphColorHex, side: THREE.DoubleSide }),
        )
        symbol.position.z = POINT_H + 0.01
        const symbolGroup = new THREE.Group()
        symbolGroup.add(symbol)
        symbolGroup.rotation.z = wp.theta ?? 0
        g.add(symbolGroup)
      }

      // 标签（紧贴点位上方，不偏移太远）
      const el = document.createElement('div')
      el.className = 'nd-label'
      const inner = document.createElement('span')
      inner.className = 'nd-label-inner'
      inner.textContent = wp.name || wp.id
      inner.style.fontSize = '10px'
      inner.style.padding = '0 3px'
      el.appendChild(inner)
      const label = new CSS2DObject(el)
      label.position.set(0, POINT_R * scale * 0.15, 0)
      g.add(label)

      this.pointsGroup.add(g)
      this.pointGroups.set(wp.id, g)
    }
    // 地图重建后恢复选中高亮（旧线圈随 clearGroup 已销毁）
    this.refreshSelectionRing()
  }

  private rebuildPaths(waypoints: Waypoint[], paths: PathInfo[]) {
    this.clearGroup(this.pathsGroup)
    const scale = this.sceneScale
    const wpMap = new Map(waypoints.map(w => [w.id, w]))
    // 车道立体条带材质（Lambert：侧壁受光差异产生立体感；细+浅+半透明，调度路线画在其上；
    // 暗色主题整体加深：颜色提一档 + 不透明度上调，避免深底上灰蒙蒙看不清）
    const laneMat = new THREE.MeshLambertMaterial({
      color: darkTheme ? LANE_DARK.color : LANE_LIGHT.color,
      transparent: true, opacity: darkTheme ? LANE_DARK.opacity : LANE_LIGHT.opacity,
    })
    const curveLaneMat = new THREE.MeshLambertMaterial({
      color: darkTheme ? CURVE_DARK.color : CURVE_LIGHT.color,
      transparent: true, opacity: darkTheme ? CURVE_DARK.opacity : CURVE_LIGHT.opacity,
    })
    // 箭头：禁写深度 + 提高绘制次序——透明物体按相机距离排序，两枚箭头中心分居中点两侧，
    // 排序会一个落在车道前一个在后（先画的丢车道深度=全遮、后画的=半透），renderOrder 强制统一
    const arrowMat = new THREE.MeshBasicMaterial({
      color: darkTheme ? ARROW_DARK.color : ARROW_LIGHT.color,
      side: THREE.DoubleSide, transparent: true,
      opacity: darkTheme ? ARROW_DARK.opacity : ARROW_LIGHT.opacity, depthWrite: false,
    })

    for (const path of paths) {
      const pts = path.waypoints
      if (!pts || pts.length < 2) continue
      for (let i = 0; i < pts.length - 1; i++) {
        const a = wpMap.get(pts[i])
        const b = wpMap.get(pts[i + 1])
        if (!a || !b) continue

        // 段几何匹配（from/to 双向匹配，控制点按方向交换）
        const seg = (path.segments ?? []).find(s =>
          (s.from === a.id && s.to === b.id) || (s.from === b.id && s.to === a.id))
        const cp = seg?.control_points
        const isCurve = !!seg && seg.segment_type.toUpperCase() === 'CURVE' && !!cp && cp.length >= 2

        let pointAt: (t: number) => THREE.Vector2
        let tangentAt: (t: number) => THREE.Vector2
        if (isCurve && cp) {
          const fwd = seg!.from === a.id && seg!.to === b.id
          const c1 = fwd ? cp[0] : cp[1]
          const c2 = fwd ? cp[1] : cp[0]
          // 立体曲段：沿贝塞尔曲线的细管（中心线在条带半高处，顶面与直段条带齐平）
          const curve3 = new THREE.CubicBezierCurve3(
            new THREE.Vector3(a.x, a.y, LANE_H / 2),
            new THREE.Vector3(c1[0], c1[1], LANE_H / 2),
            new THREE.Vector3(c2[0], c2[1], LANE_H / 2),
            new THREE.Vector3(b.x, b.y, LANE_H / 2))
          this.pathsGroup.add(new THREE.Mesh(
            new THREE.TubeGeometry(curve3, 48, LANE_H / 2, 8), curveLaneMat))
          const curve = new THREE.CubicBezierCurve(
            new THREE.Vector2(a.x, a.y),
            new THREE.Vector2(c1[0], c1[1]),
            new THREE.Vector2(c2[0], c2[1]),
            new THREE.Vector2(b.x, b.y))
          pointAt = t => curve.getPoint(t)
          tangentAt = t => curve.getTangent(t)
        } else {
          const va = new THREE.Vector2(a.x, a.y)
          const vb = new THREE.Vector2(b.x, b.y)
          pointAt = t => va.clone().lerp(vb, t)
          tangentAt = () => vb.clone().sub(va)
          // 立体直段：薄条带（长度沿线，厚度凸出地面）
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          if (len > 0.01) {
            const strip = new THREE.Mesh(new THREE.BoxGeometry(len, LANE_W, LANE_H), laneMat)
            strip.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, LANE_H / 2)
            strip.rotation.z = Math.atan2(b.y - a.y, b.x - a.x)
            this.pathsGroup.add(strip)
          }
        }

        // 方向箭头：双向 = 中点两侧三角形背靠背；单向 = 中心单箭头 from→to
        const addArrow = (t: number, forward: boolean, offsetUnits: number) => {
          const p = pointAt(t)
          const tan = tangentAt(Math.min(Math.max(t, 0.02), 0.98)).normalize()
          const angle = Math.atan2(tan.y, tan.x) + (forward ? 0 : Math.PI)
          const arrowShape = new THREE.Shape()
          const s = 0.21 * scale
          arrowShape.moveTo(s * 0.3, 0)
          arrowShape.lineTo(-s * 0.2, s * 0.3)
          arrowShape.lineTo(-s * 0.2, -s * 0.3)
          arrowShape.closePath()
          // 立体箭头：拉伸薄片贴在车道顶面上（与点位/车道同风格的微高度）
          const arrow = new THREE.Mesh(
            new THREE.ExtrudeGeometry(arrowShape, { depth: 0.012, bevelEnabled: false }),
            arrowMat,
          )
          arrow.position.set(p.x + tan.x * offsetUnits * s, p.y + tan.y * offsetUnits * s, LANE_H)
          arrow.rotation.z = angle
          arrow.renderOrder = 1
          this.pathsGroup.add(arrow)
        }
        if (path.bidirectional) {
          // <> 背靠背：三角形基底在自身原点后 0.2s，偏移正好 0.2s 让两基底在中点贴合（无重叠无缝隙）
          addArrow(0.5, true, 0.2)
          addArrow(0.5, false, -0.2)
        } else {
          addArrow(0.5, true, 0)
        }
      }
    }
    this.mergePaths()
    for (const material of [laneMat, curveLaneMat, arrowMat]) {
      if (!this.pathsGroup.children.some(child => (child as THREE.Mesh).material === material)) material.dispose()
    }
  }

  /** 静态车道按共享材质合并，减少拖动视角时每条车道、箭头的独立 draw call。 */
  private mergePaths() {
    const batches = new Map<THREE.Material, THREE.Mesh[]>()
    for (const child of this.pathsGroup.children) {
      if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue
      const meshes = batches.get(child.material) ?? []
      meshes.push(child)
      batches.set(child.material, meshes)
    }
    for (const [material, meshes] of batches) {
      if (meshes.length < 2) continue
      const copies = meshes.map(mesh => {
        mesh.updateMatrix()
        return mesh.geometry.clone().applyMatrix4(mesh.matrix)
      })
      const merged = mergeGeometries(copies)
      copies.forEach(geometry => geometry.dispose())
      if (!merged) continue
      const batch = new THREE.Mesh(merged, material)
      batch.renderOrder = meshes[0].renderOrder
      for (const mesh of meshes) {
        mesh.removeFromParent()
        mesh.geometry.dispose()
      }
      this.pathsGroup.add(batch)
    }
  }

  private rebuildZones(zones: Zone[]) {
    this.clearGroup(this.zonesGroup)
    for (const zone of zones) {
      if (!zone.vertices || zone.vertices.length < 3) continue
      const color = zone.type === 'forbidden' ? 0xf56c6c : zone.type === 'ramp' ? 0xe6a23c : 0x409eff
      const shape = new THREE.Shape()
      zone.vertices.forEach(([x, y], i) => {
        if (i === 0) shape.moveTo(x, y)
        else shape.lineTo(x, y)
      })
      shape.closePath()
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
      )
      mesh.position.z = 0.001
      this.zonesGroup.add(mesh)
      // 边框
      const pts: number[] = []
      zone.vertices.forEach(([x, y]) => pts.push(x, y, 0.003))
      pts.push(zone.vertices[0][0], zone.vertices[0][1], 0.003)
      const edgeGeo = new THREE.BufferGeometry()
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      this.zonesGroup.add(new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 })))
    }
  }

  // ==================== 机器人 ====================

  private createRobotMesh(code: string): RobotMesh {
    const root = new THREE.Group()
    root.userData.robotCode = code
    const color = this.robotColor(code)
    const body = new THREE.Group()

    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(ROBOT_L, ROBOT_W, 0.1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
    )
    chassis.position.z = 0.05
    body.add(chassis)
    // 轮廓：像素级粗线，与路线/终点环同色（机器人身份色）
    const edgeGeo = new LineSegmentsGeometry().fromEdgesGeometry(
      new THREE.EdgesGeometry(chassis.geometry))
    const edgeMat = new LineMaterial({ color, linewidth: 4, transparent: true, opacity: 1 })
    edgeMat.resolution.copy(this.renderer.getSize(new THREE.Vector2()))
    const edges = new LineSegments2(edgeGeo, edgeMat)
    edges.position.z = 0.05
    body.add(edges)

    // V 形朝向
    const chevronShape = new THREE.Shape()
    const s = ROBOT_L * 0.25
    chevronShape.moveTo(0, s * 0.5); chevronShape.lineTo(s, 0); chevronShape.lineTo(0, -s * 0.5)
    chevronShape.lineTo(0, -s * 0.5 + 0.02); chevronShape.lineTo(s - 0.04, 0); chevronShape.lineTo(0, s * 0.5 - 0.02)
    chevronShape.closePath()
    const chevron = new THREE.Mesh(
      new THREE.ShapeGeometry(chevronShape),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    )
    chevron.position.set(ROBOT_L * 0.1, 0, 0.11)
    body.add(chevron)

    // 不可见拾取体（放大悬停/点击命中范围：本体缩小后 0.28x0.21 很难点中，
    // 徽标下方及周边区域都算机器人——射线照常命中，渲染彻底跳过）
    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.8, 0.7),
      new THREE.MeshBasicMaterial(),
    )
    hitProxy.material.visible = false
    hitProxy.position.set(0, 0.1, 0.3)
    body.add(hitProxy)

    root.add(body)

    const el = document.createElement('div')
    el.className = 'nd-label'
    const inner = document.createElement('span')
    inner.className = 'nd-label-inner nd-label-inner--robot'
    inner.textContent = code
    el.appendChild(inner)
    const label = new CSS2DObject(el)
    label.position.set(0, 0.4, 0.15)
    root.add(label)

    return { root, body, label, code, shown: null, motion: null, badgeKey: '' }
  }

  // ==================== 相机 ====================

  private fitCamera(waypoints: Waypoint[]) {
    if (waypoints.length === 0) return
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const w of waypoints) {
      minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x)
      minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y)
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const span = Math.max(maxX - minX, maxY - minY, 10)
    this.mapCenter.set(cx, cy, 0)
    this.cameraDistance = span * 1.3
    this.sceneScale = Math.max(1, span / 15)
    this.controls.target.copy(this.mapCenter)
    this.setPreset(this.currentPreset)
  }

  // ==================== 渲染 ====================

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    // Line2 像素线宽依赖画布分辨率（机器人轮廓描边；路线已立体化为圆管，无分辨率依赖）
    const lineMats: LineMaterial[] = []
    this.robotsGroup.traverse(obj => {
      const mat = (obj as LineSegments2).material as LineMaterial | undefined
      if (mat?.resolution) lineMats.push(mat)
    })
    lineMats.forEach(mat => mat.resolution.set(w, h))
    this.invalidate()
  }

  /** 删除场景对象不等于释放 GPU 资源；共享材质在本组内只释放一次。 */
  private clearGroup(group: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    group.traverse(obj => {
      if (obj instanceof CSS2DObject) obj.element.remove()
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) geometries.add(mesh.geometry)
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const mat of mats) {
        materials.add(mat)
        for (const value of Object.values(mat)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
      }
    })
    geometries.forEach(geometry => geometry.dispose())
    textures.forEach(texture => texture.dispose())
    materials.forEach(material => material.dispose())
    group.clear()
  }

  private animate = (now: number) => {
    this.animationId = 0
    if (this.disposed) return
    let moving = false
    for (const mesh of this.robots.values()) {
      const motion = mesh.motion
      if (!motion) continue
      const t = Math.min(1, Math.max(0, (now - motion.startedAt) / 300))
      mesh.root.position.x = THREE.MathUtils.lerp(motion.x, motion.target.x, t)
      mesh.root.position.y = THREE.MathUtils.lerp(motion.y, motion.target.y, t)
      const delta = Math.atan2(Math.sin(motion.target.yaw - motion.yaw), Math.cos(motion.target.yaw - motion.yaw))
      mesh.body.rotation.z = motion.yaw + delta * t
      if (t === 1) mesh.motion = null
      else moving = true
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
    if (moving) this.invalidate()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.animationId)
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp)
    this.resizeObs.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.controls.removeEventListener('change', this.invalidate)
    this.controls.dispose()
    this.clearGroup(this.scene)
    this.robots.clear()
    this.pointGroups.clear()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}

interface RobotMesh {
  root: THREE.Group
  body: THREE.Group
  label: CSS2DObject
  code: string
  shown: { x: number; y: number; yaw: number } | null
  motion: { x: number; y: number; yaw: number; startedAt: number;
    target: { x: number; y: number; yaw: number } } | null
  badgeKey: string
}
