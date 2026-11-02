/**
 * 地图 Three.js 画布：地图背景 + 点位/路径/区域/机器人 + 射线拾取 + 右键菜单回调。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { pointStyle } from '@/utils/pointStyle'
import { robotDisplayName } from '@/utils/robotNames'
import type { Waypoint, PathInfo, Zone, RobotInfo, ActiveRoute } from '@/types'

const POINT_R = 0.19
const POINT_H = 0.02
const LANE_W = 0.05
const LANE_H = 0.02
const ROBOT_L = 0.42
const ROBOT_W = 0.32
const GLYPH_COLOR = 0x52667a

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
    this.renderer.setPixelRatio(window.devicePixelRatio)
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
    this.animate()
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

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDownAt = { x: e.clientX, y: e.clientY }
  }

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDownAt
    this.pointerDownAt = null
    if (!down || !this.onRobotClick) return
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
      if (obj?.userData?.robotCode) this.onRobotClick(obj.userData.robotCode as string)
    }
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
  }

  getPreset(): ViewPreset { return this.currentPreset }
  fitView() { this.setPreset(this.currentPreset) }

  // ==================== 地图背景图 ====================

  async loadMapImage(imageUrl: string, geo: MapGeoInfo) {
    if (!geo.loaded || !geo.resolution || !geo.width || !geo.height) return
    try {
      const loader = new THREE.TextureLoader()
      const texture = await loader.loadAsync(imageUrl)
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
      this.mapImageGroup.clear()
      this.mapImageGroup.add(plane)
      this.gridGroup.visible = false
    } catch { /* 图片不可用 */ }
  }

  // ==================== 数据更新 ====================

  updateMap(data: { waypoints: Waypoint[]; paths: PathInfo[]; zones: Zone[] }) {
    this.fitCamera(data.waypoints)
    this.rebuildPoints(data.waypoints)
    this.rebuildPaths(data.waypoints, data.paths)
    this.rebuildZones(data.zones)
  }

  updateRobots(robots: RobotInfo[], selectedCode = '') {
    const activeCodes = new Set<string>()
    for (const r of robots) {
      if (!r.pose) continue
      activeCodes.add(r.robot_code)
      let mesh = this.robots.get(r.robot_code)
      if (!mesh) {
        mesh = this.createRobotMesh(r.robot_code)
        this.robots.set(r.robot_code, mesh)
        this.robotsGroup.add(mesh.root)
      }
      const focused = r.robot_code === selectedCode
      mesh.root.visible = true
      mesh.root.scale.setScalar(this.sceneScale * (focused ? 1.3 : 1))
      mesh.root.position.x = r.pose.x
      mesh.root.position.y = r.pose.y
      mesh.body.rotation.z = r.pose.yaw
      const el = mesh.label.element as HTMLDivElement
      const inner = el.querySelector('.nd-label-inner--robot') as HTMLSpanElement
      if (inner) {
        const battery = r.battery != null ? `${Math.round(r.battery)}%` : '--'
        const displayName = robotDisplayName(r.robot_code)
        // 在线但不可派发（离图/异常模式/地图不一致）→ ⚠ 前缀 + 橙底，前端一眼可见（否则 mode=idle 看起来正常）
        const anomalous = r.online_status === 'online' && !r.dispatchable
        inner.textContent = `${anomalous ? '⚠ ' : ''}${displayName} ${r.mode} ${battery}`
        inner.style.background = anomalous ? 'rgba(230,162,60,0.92)'
          : r.mode === 'running' ? 'rgba(64,158,255,0.85)'
          : r.mode === 'charging' ? 'rgba(103,194,58,0.85)'
          : r.mode === 'error' ? 'rgba(245,108,108,0.9)'
          : 'rgba(38,42,50,0.78)'
        inner.style.outline = focused ? '2px solid #409eff' : 'none'
        const codeEl = el.querySelector('.nd-label-code--robot') as HTMLDivElement
        if (codeEl) {
          codeEl.textContent = r.robot_code
        }
      }
    }
    for (const [code, mesh] of this.robots) {
      if (!activeCodes.has(code)) mesh.root.visible = false
    }
  }

  // ==================== 活动路线 ====================

  /**
   * 更新活动路线渲染：已走段灰色细线、剩余段彩色虚线、终点色环。
   * 凌乱控制：showAll=false 时仅画选中机器人的路线（聚焦态加粗提亮）。
   * 线用 Line2（像素线宽）：THREE.Line 固定 1px，浅底图上不可见。
   */
  updateRoutes(routes: ActiveRoute[], selectedCode = '', showAll = true) {
    this.routesGroup.clear()
    const scale = this.sceneScale
    const res = this.renderer.getSize(new THREE.Vector2())
    for (const route of routes) {
      const focused = route.robot_code === selectedCode
      if (!showAll && !focused) continue
      const pts = route.waypoints.filter(p => p.x != null && p.y != null)
      if (pts.length < 2) continue
      const color = this.robotColor(route.robot_code)
      // 车道条带顶面 0.02 之上（避免被立体条带遮挡/穿插）
    const z = focused ? 0.05 : 0.04

      // 已走段：灰色实线（深一档保证可见：浅灰细线在浅底图上等同隐形）
      const cut = Math.min(route.progress, pts.length - 1)
      const traveled = pts.slice(0, cut + 1)
      if (traveled.length >= 2) {
        this.routesGroup.add(this.buildFatLine(traveled, z, new LineMaterial({
          color: 0x7d8794, linewidth: focused ? 3 : 2,
          transparent: true, opacity: focused ? 0.6 : 0.45,
        }), res))
      }

      // 剩余段：彩色虚线（聚焦提亮加粗）；dash 尺寸用固定世界米制——
      // 不能乘 sceneScale（大地图 scale≈3 时一段虚线 3.9m 比路段还长，视觉上退化为实线）
      const remaining = pts.slice(cut)
      if (remaining.length >= 2) {
        this.routesGroup.add(this.buildFatLine(remaining, z, new LineMaterial({
          color, linewidth: focused ? 7 : 5,
          transparent: true, opacity: focused ? 0.95 : 0.7,
          dashed: true, dashSize: 0.6, gapSize: 0.4,
        }), res, true))
      }

      // 终点细色环（目标点标识，同机器人色）
      const dest = pts[pts.length - 1]
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.18 * scale, 0.26 * scale, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
      )
      ring.position.set(dest.x!, dest.y!, z + 0.01)
      this.routesGroup.add(ring)
    }
  }

  /** 像素级线宽折线（Line2；dashed 需 computeLineDistances） */
  private buildFatLine(pts: ActiveRoute['waypoints'], z: number, material: LineMaterial,
                       resolution: THREE.Vector2, dashed = false): Line2 {
    const positions: number[] = []
    for (const p of pts) positions.push(p.x!, p.y!, z)
    const geo = new LineGeometry()
    geo.setPositions(positions)
    material.resolution.copy(resolution)
    const line = new Line2(geo, material)
    if (dashed) line.computeLineDistances()
    return line
  }

  // ==================== 点位构建 ====================

  private rebuildPoints(waypoints: Waypoint[]) {
    this.pointsGroup.clear()
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

      // 立体圆盘（短圆柱凸台）：MeshBasic 不受光，颜色与 2D 视图 #95d475 完全一致
      // （Lambert 受光会把浅绿压成深绿，立体感由圆柱侧壁轮廓体现即可）
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(POINT_R, POINT_R, POINT_H, 28),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(style.color) }),
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
        new THREE.MeshBasicMaterial({ color: GLYPH_COLOR, side: THREE.DoubleSide }),
      )
      arrow.position.z = POINT_H + 0.012
      const arrowGroup = new THREE.Group()
      arrowGroup.add(arrow)
      arrowGroup.rotation.z = wp.theta
      g.add(arrowGroup)

      // 后半圆类型符号（偏移到 -x 方向，不随 theta 旋转，凸台顶面之上）
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
          new THREE.MeshBasicMaterial({ color: GLYPH_COLOR, side: THREE.DoubleSide }),
        )
        symbol.position.z = POINT_H + 0.01
        g.add(symbol)
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
  }

  private rebuildPaths(waypoints: Waypoint[], paths: PathInfo[]) {
    this.pathsGroup.clear()
    const scale = this.sceneScale
    const wpMap = new Map(waypoints.map(w => [w.id, w]))
    // 车道立体条带材质（Lambert：侧壁受光差异产生立体感；细+浅+半透明，调度路线画在其上）
    const laneMat = new THREE.MeshLambertMaterial({ color: 0x606266, transparent: true, opacity: 0.4 })
    const curveLaneMat = new THREE.MeshLambertMaterial({ color: 0x7a8fb5, transparent: true, opacity: 0.5 })
    // 箭头：禁写深度 + 提高绘制次序——透明物体按相机距离排序，两枚箭头中心分居中点两侧，
    // 排序会一个落在车道前一个在后（先画的丢车道深度=全遮、后画的=半透），renderOrder 强制统一
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0x7ab7ff, side: THREE.DoubleSide, transparent: true, opacity: 0.7, depthWrite: false,
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
          const s = 0.25 * scale
          arrowShape.moveTo(s * 0.3, 0)
          arrowShape.lineTo(-s * 0.2, s * 0.3)
          arrowShape.lineTo(-s * 0.2, -s * 0.3)
          arrowShape.closePath()
          const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), arrowMat)
          arrow.position.set(p.x + tan.x * offsetUnits * s, p.y + tan.y * offsetUnits * s, LANE_H + 0.005)
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
  }

  private rebuildZones(zones: Zone[]) {
    this.zonesGroup.clear()
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

    root.add(body)

    const el = document.createElement('div')
    el.className = 'nd-label'
    const inner = document.createElement('span')
    inner.className = 'nd-label-inner nd-label-inner--robot'
    inner.textContent = code
    el.appendChild(inner)
    const codeLine = document.createElement('div')
    codeLine.className = 'nd-label-code--robot'
    codeLine.textContent = code
    el.appendChild(codeLine)
    const label = new CSS2DObject(el)
    label.position.set(0, 0.4, 0.15)
    root.add(label)

    return { root, body, label, code, shown: null }
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
    // Line2 像素线宽依赖画布分辨率（路线 + 机器人轮廓）
    const lineMats: LineMaterial[] = []
    this.routesGroup.traverse(obj => {
      const mat = (obj as Line2).material as LineMaterial | undefined
      if (mat?.resolution) lineMats.push(mat)
    })
    this.robotsGroup.traverse(obj => {
      const mat = (obj as LineSegments2).material as LineMaterial | undefined
      if (mat?.resolution) lineMats.push(mat)
    })
    lineMats.forEach(mat => mat.resolution.set(w, h))
  }

  private animate = () => {
    if (this.disposed) return
    this.animationId = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.animationId)
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp)
    this.resizeObs.disconnect()
    this.controls.dispose()
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
}
