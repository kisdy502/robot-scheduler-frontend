import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// 使用真实 Three.js 几何体与材质；仅隔离浏览器渲染器、DOM 和时钟，不访问后端或机器人。
function harness() {
  let now = 0
  let id = 0
  const frames = new Map()
  const timers = new Map()
  const document = { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: element }
  function element() {
    return { style: {}, children: [], clientWidth: 800, clientHeight: 600, innerHTML: '',
      appendChild(child) { this.children.push(child) }, remove() { this.removed = true },
      addEventListener() {}, removeEventListener() {}, classList: { toggle() {} },
      querySelector() { return this.children[0] },
    }
  }
  class Renderer {
    domElement = element()
    calls = 0
    setSize(w, h) { this.width = w; this.height = h }
    setPixelRatio(value) { this.pixelRatio = value }
    getSize(target) { return target.set(this.width, this.height) }
    render() { this.calls++ }
    dispose() { this.disposed = true }
  }
  class Controls extends THREE.EventDispatcher {
    target = new THREE.Vector3()
    update() {}
    dispose() {}
  }
  class Label extends THREE.Object3D {
    constructor(el) { super(); this.element = el }
  }
  const modules = {
    three: { ...THREE, WebGLRenderer: Renderer },
    'three/examples/jsm/controls/OrbitControls.js': { OrbitControls: Controls },
    'three/examples/jsm/renderers/CSS2DRenderer.js': { CSS2DObject: Label, CSS2DRenderer: Renderer },
    'three/examples/jsm/lines/Line2.js': { Line2 },
    'three/examples/jsm/lines/LineGeometry.js': { LineGeometry },
    'three/examples/jsm/lines/LineMaterial.js': { LineMaterial },
    'three/examples/jsm/lines/LineSegments2.js': { LineSegments2 },
    'three/examples/jsm/lines/LineSegmentsGeometry.js': { LineSegmentsGeometry },
    'three/examples/jsm/utils/BufferGeometryUtils.js': { mergeGeometries },
  }
  function load(path, suffix = '') {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8')
    const source = (path.endsWith('.vue') ? text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] : text) + suffix
    const code = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText
    const context = { exports: {}, console, document, window: { devicePixelRatio: 3 },
      performance: { now: () => now },
      requestAnimationFrame: cb => { frames.set(++id, cb); return id },
      cancelAnimationFrame: value => frames.delete(value),
      setTimeout: cb => { timers.set(++id, cb); return id }, clearTimeout: value => timers.delete(value),
      ResizeObserver: class { observe() {} disconnect() {} },
      require: key => { if (!(key in modules)) throw new Error(`Unexpected import: ${key}`); return modules[key] },
    }
    vm.runInNewContext(code, context)
    return context.exports
  }
  modules['@/utils/pointStyle'] = load('../src/utils/pointStyle.ts')
  modules['@/utils/robotNames'] = load('../src/utils/robotNames.ts')
  const { MapCanvas } = load('../src/three/MapCanvas.ts')
  const canvas = new MapCanvas(element())
  return { canvas, frames, timers, document, modules, load, element,
    flush(time = now) {
      now = time
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(cb => cb(time))
    },
  }
}

const robot = (x = 0, yaw = 0) => ({ robot_code: 'R1', online_status: 'online', dispatchable: true,
  mode: 'idle', battery: 80, pose: { x, y: 0, yaw } })
const route = progress => ({ robot_code: 'R1', progress,
  waypoints: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] })

// 静止数据和心跳重复到达不应持续提交渲染，多个变更只排一个动画帧。
test('idle rendering sleeps and repeated snapshots do not redraw', () => {
  const h = harness()
  h.canvas.updateRobots([robot()])
  h.canvas.updateRobots([robot()])
  assert.equal(h.frames.size, 1)
  h.flush()
  assert.equal(h.frames.size, 0)
  assert.equal(h.canvas.renderer.pixelRatio, 1.5)
  const calls = h.canvas.renderer.calls
  h.canvas.updateRobots([robot()])
  assert.equal(h.frames.size, 0)
  assert.equal(h.canvas.renderer.calls, calls)
  h.canvas.dispose()
})

// 路线心跳不重建；进度变化重建时，旧几何体和材质必须逐个释放。
test('unchanged routes reuse objects and changed routes dispose old GPU resources', () => {
  const h = harness()
  h.canvas.updateRoutes([route(0)])
  const children = [...h.canvas.routesGroup.children]
  h.canvas.updateRoutes([{ ...route(0), updated_at: 1234 }])
  assert.deepEqual(h.canvas.routesGroup.children, children)
  let geometries = 0, materials = 0
  children.forEach(child => {
    child.geometry.addEventListener('dispose', () => geometries++)
    child.material.addEventListener('dispose', () => materials++)
  })
  h.canvas.updateRoutes([route(1)])
  assert.equal(geometries, children.length)
  assert.equal(materials, children.length)
  h.canvas.updateRoutes([])
  assert.equal(h.canvas.routesGroup.children.length, 0)
  h.canvas.dispose()
})

// 静态路径的材质相同则合并绘制，保留世界坐标与箭头绘制顺序。
test('static lanes merge into a small number of draw objects', () => {
  const h = harness()
  const waypoints = [0, 5, 10].map((x, i) => ({ id: `P${i}`, x, y: 0, theta: 0, type: 'path' }))
  h.canvas.updateMap({ waypoints, zones: [], paths: [0, 1].map(i => ({
    id: `L${i}`, waypoints: [`P${i}`, `P${i + 1}`], bidirectional: true,
  })) })
  assert.equal(h.canvas.pathsGroup.children.length, 2)
  const lane = h.canvas.pathsGroup.children.find(child => child.renderOrder === 0)
  lane.geometry.computeBoundingBox()
  assert.ok(Math.abs(lane.geometry.boundingBox.min.x) < 1e-6)
  assert.ok(Math.abs(lane.geometry.boundingBox.max.x - 10) < 1e-6)
  h.canvas.dispose()
})

// 显示插值只在两个观测点之间移动；跨 ±π 的旋转取短路径，完成后停止动画。
test('robot interpolation follows shortest yaw and stops at the observed pose', () => {
  const h = harness()
  h.canvas.updateRobots([robot(0, Math.PI * 170 / 180)])
  h.flush(0)
  h.canvas.updateRobots([robot(6, -Math.PI * 170 / 180)])
  h.flush(150)
  const mesh = h.canvas.robots.get('R1')
  assert.ok(Math.abs(mesh.root.position.x - 3) < 1e-6)
  assert.ok(Math.abs(mesh.body.rotation.z - Math.PI) < 1e-6)
  h.flush(300)
  assert.equal(mesh.root.position.x, 6)
  assert.equal(h.frames.size, 0)
  h.canvas.dispose()
})

// 页面退出时共享资源只释放一次，遗留的动画帧也必须取消。
test('dispose releases shared geometry material and texture once', () => {
  const h = harness()
  const texture = new THREE.Texture()
  const material = new THREE.MeshBasicMaterial({ map: texture })
  const geometry = new THREE.PlaneGeometry()
  h.canvas.scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
  let g = 0, m = 0, t = 0
  geometry.addEventListener('dispose', () => g++)
  material.addEventListener('dispose', () => m++)
  texture.addEventListener('dispose', () => t++)
  h.canvas.dispose()
  h.canvas.dispose()
  assert.deepEqual([g, m, t], [1, 1, 1])
  assert.equal(h.frames.size, 0)
})

// 从清单移除的机器人必须清理模型和标签，不能永久留在渲染缓存中。
test('removed robots release their visual resources', () => {
  const h = harness()
  h.canvas.updateRobots([robot()])
  const mesh = h.canvas.robots.get('R1')
  h.canvas.updateRobots([])
  assert.equal(h.canvas.robots.size, 0)
  assert.equal(h.canvas.robotsGroup.children.length, 0)
  assert.equal(mesh.label.element.removed, true)
  h.canvas.dispose()
})

function pollingHarness() {
  const h = harness()
  let resolveRobots
  let calls = 0, updates = 0
  h.modules.vue = {
    ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter() } }),
    onMounted() {}, onUnmounted() {},
  }
  h.modules['element-plus'] = { ElMessage: {} }
  h.modules['@/three/MapCanvas'] = { MapCanvas: class {} }
  h.modules['@/api/scheduler'] = { schedulerApi: {
    robots: () => { calls++; return new Promise(resolve => { resolveRobots = resolve }) },
    activeRoutes: async () => [],
  } }
  h.modules.testVisuals = { updateRobots: () => updates++, updateRoutes() {} }
  const flow = h.load('../src/views/MapView.vue', `
exports.poll = pollRobots;
exports.activate = () => { stopped = false; canvas = require('testVisuals'); };
exports.deactivate = () => { stopped = true; };
`)
  flow.activate()
  return { h, flow, resolve: () => resolveRobots([robot()]), calls: () => calls, updates: () => updates }
}

// 慢请求期间的新一轮调用不叠加，完成后只安排一次下一轮；后台页面不发请求。
test('polling never overlaps and hidden pages do not fetch', async () => {
  const p = pollingHarness()
  const first = p.flow.poll()
  await p.flow.poll()
  assert.equal(p.calls(), 1)
  p.resolve()
  await first
  assert.equal(p.updates(), 1)
  assert.equal(p.h.timers.size, 1)
  p.h.document.hidden = true
  await p.flow.poll()
  assert.equal(p.calls(), 1)
  p.h.canvas.dispose()
})

// 离开地图页后才返回的请求不能更新已销毁的画布，也不能重启轮询。
test('late poll response after unmount neither updates nor reschedules', async () => {
  const p = pollingHarness()
  const pending = p.flow.poll()
  p.flow.deactivate()
  p.resolve()
  await pending
  assert.equal(p.updates(), 0)
  assert.equal(p.h.timers.size, 0)
  p.h.canvas.dispose()
})
