<template>
  <el-card shadow="never">
    <template #header>
      <div class="card-header">
        <span>任务历史（业务流聚合）</span>
        <div class="filters">
          <el-select v-model="filters.status" placeholder="状态" clearable size="small" style="width:110px" @change="load">
            <el-option v-for="s in statusOptions" :key="s" :label="zhStatus(s)" :value="s" />
          </el-select>
          <el-select v-model="filters.category" placeholder="类型" clearable size="small" style="width:120px" @change="load">
            <el-option v-for="c in categoryOptions" :key="c" :label="zhCategory(c)" :value="c" />
          </el-select>
          <el-input v-model="filters.robot_code" placeholder="机器人" clearable size="small" style="width:150px" @keyup.enter="load" />
          <el-button size="small" type="primary" @click="load">查询</el-button>
        </div>
      </div>
    </template>
    <el-table :data="rows" stripe size="small" row-key="rmf_task_id"
              :default-sort="{ prop: 'updated_at', order: 'descending' }" max-height="calc(100vh - 200px)">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="flow-timeline">
            <div class="planned-route">规划路线 · {{ row.robot_code || '--' }}：{{ routeText(row) }}</div>
            <div v-for="(n, i) in timelineOf(row)" :key="i" class="flow-node" :class="'node-' + n.kind + ' ' + ('st-' + n.state)">
              <span class="node-icon">{{ nodeIcon(n) }}</span>
              <span class="node-title">{{ n.title }}</span>
              <span class="node-time">{{ n.time ? fmtTime(n.time) : '--' }}</span>
              <span class="node-detail">{{ n.detail }}</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="任务 ID" min-width="88" fixed="left">
        <template #default="{ row }">
          <div class="id-cell">
            <div class="id-biz" :title="row.business_task_id">{{ row.business_task_id || '--' }}</div>
            <div class="id-kernel" :title="row.rmf_task_id">{{ row.rmf_task_id || '--' }}</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="80">
        <template #default="{ row }">{{ zhCategory(row.category) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="130">
        <template #default="{ row }">
          <div class="status-cell">
            <el-tag :type="tagType(row.status)" size="small">{{ zhStatus(row.status) }}</el-tag>
            <el-tag v-if="row.cancellation" type="info" size="small" effect="plain">取消</el-tag>
            <el-button v-if="!isFinal(row.status)" class="cancel-btn" link type="danger" size="small"
                       @click="cancelTask(row)">✕</el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="机器人" width="170">
        <template #default="{ row }">
          <div class="robot-cell">
            <div class="robot-name">{{ robotName(row.robot_code) || row.robot_code || '--' }}</div>
            <div class="robot-code">{{ row.robot_code ?? '' }}</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="业务流" width="150">
        <template #default="{ row }">
          <div class="flow-badges">
            <span class="flow-badge" :class="usageOf(row, 'OCCUPIED') ? 'b-on' : 'b-off'"
                  :title="usageOf(row, 'OCCUPIED') ? '占用 ' + fmtTime(usageOf(row, 'OCCUPIED')!.first_at) : '无占用记录'">🔒</span>
            <span class="flow-arrow">→</span>
            <el-tag :type="tagType(row.status)" size="small" effect="plain">移动</el-tag>
            <template v-if="activityOf(row)">
              <span class="flow-arrow">→</span>
              <span class="flow-badge" :class="activityOf(row)!.action_status === 3 ? 'b-ok' : 'b-fail'"
                    :title="activityOf(row)!.action_status === 3 ? '业务动作成功' : '业务动作失败'">
                {{ activityOf(row)!.action_status === 3 ? '✓动作' : '✕动作' }}
              </span>
            </template>
            <span class="flow-arrow">→</span>
            <span class="flow-badge" :class="usageOf(row, 'RELEASED') ? 'b-on' : 'b-wait'"
                  :title="usageOf(row, 'RELEASED') ? '释放 ' + fmtTime(usageOf(row, 'RELEASED')!.first_at) : '未释放'">🔓</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="质检" width="70" align="center">
        <template #default="{ row }">
          <el-tag v-if="qcResultOf(row)" :type="qcResultOf(row) === 'NG' ? 'danger' : 'success'" size="small"
                  style="cursor: pointer" @click="showReport(row)">
            {{ qcResultOf(row) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="200">
        <template #default="{ row }">
          <span :style="{ color: row.status === 'failed' ? '#f56c6c' : '#606266', fontSize: '12px' }">{{ row.message ?? '' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="规划路线" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ routeText(row) }}</template>
      </el-table-column>
      <el-table-column label="请求" width="60" align="center">
        <template #default="{ row }">
          <el-button v-if="row.request_payload" link type="primary" size="small" @click="showRequest(row)">报文</el-button>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="150" prop="updated_at" sortable>
        <template #default="{ row }">
          <span style="color:#909399;font-size:11px">{{ fmtTime(row.updated_at) }}</span>
        </template>
      </el-table-column>
    </el-table>
    <div class="pager">
      <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" @current-change="load" />
    </div>

    <!-- 质检结果报文（外部动作镜像） -->
    <el-dialog v-model="reportDlg.visible" title="质检结果报文（上层动作镜像）" width="640px" align-center>
      <div class="report-meta" v-if="reportDlg.row">
        <span>{{ reportDlg.row.business_task_id }}</span>
        <el-tag size="small" :type="reportDlg.result === 'NG' ? 'danger' : 'success'">{{ reportDlg.result }}</el-tag>
        <span style="color:#909399">{{ reportDlg.row.robot_code }}</span>
      </div>
      <pre class="report-json">{{ reportDlg.json }}</pre>
    </el-dialog>

    <!-- 请求报文（下发时的原始请求镜像） -->
    <el-dialog v-model="requestDlg.visible" title="任务请求报文" width="560px" align-center>
      <div class="report-meta" v-if="requestDlg.row">
        <span>{{ requestDlg.row.business_task_id }}</span>
        <el-tag size="small" type="primary">{{ zhCategory(requestDlg.row.category) }}</el-tag>
        <span style="color:#909399">{{ fmtTime(requestDlg.row.updated_at) }}</span>
      </div>
      <pre class="report-json">{{ requestDlg.json }}</pre>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames, robotDisplayName } from '@/utils/robotNames'
import type { TaskRecord, RobotInfo } from '@/types'

/**
 * 新版架构任务视图：同一业务流（task_id）聚合三条记录来源——
 * 占用/释放（调度 USAGE 事件）+ 移动（调度 t_task_record）+ 业务动作（RMS 回执镜像 t_external_activity）。
 */

const rows = ref<TaskRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const filters = ref({ status: '', category: '', robot_code: '' })
const robots = ref<RobotInfo[]>([])

/** 外部动作镜像索引：body_task_id → activity */
const activityByTaskId = ref<Map<string, any>>(new Map())
/** 占用事件索引：`${robot}|${taskflow}` → { OCCUPIED, RELEASED } */
const usageByKey = ref<Map<string, Record<string, any>>>(new Map())

function robotName(code: string): string {
  return robotDisplayName(code)
}

function routeText(row: TaskRecord): string {
  const route = row.detail?.route_waypoints
  return Array.isArray(route) && route.length ? route.join(' → ') : '暂无规划路线'
}

const statusOptions = ['queued', 'underway', 'completed', 'failed', 'canceled']
const categoryOptions = ['go_to_place', 'quality_inspection', 'charge', 'swap_battery', 'return_home', 'pause_task', 'resume_task']

const statusMap: Record<string, string> = {
  underway: '执行中', queued: '排队中', completed: '已完成', failed: '失败', canceled: '已取消',
}
const tagTypeMap: Record<string, string> = {
  completed: 'success', failed: 'danger', underway: 'primary', queued: 'warning', canceled: 'info',
}
const categoryMap: Record<string, string> = {
  go_to_place: '移动', quality_inspection: '移动到作业点', charge: '移动到充电位', swap_battery: '换电',
  return_home: '归巢', pause_task: '暂停', resume_task: '恢复', cache_task_context: '缓存',
}

const zhStatus = (s: string) => statusMap[s] ?? s
const zhCategory = (s: string) => categoryMap[s] ?? s
const tagType = (s: string) => tagTypeMap[s] ?? 'info'
const isFinal = (s: string) => s === 'completed' || s === 'failed' || s === 'canceled'
const fmtTime = (ts: number | null) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''

/** 行关联：外部动作镜像（body_task_id = 移动任务 task_id） */
function activityOf(row: TaskRecord): any | null {
  return row.business_task_id ? (activityByTaskId.value.get(row.business_task_id) ?? null) : null
}

/** 行关联：占用/释放事件（robot + taskflow_id，taskflow 取自请求报文镜像） */
function usageOf(row: TaskRecord, reason: 'OCCUPIED' | 'RELEASED'): any | null {
  const tf = (row.request_payload as any)?.taskflow_id
  if (!tf || !row.robot_code) return null
  return usageByKey.value.get(`${row.robot_code}|${tf}`)?.[reason] ?? null
}

/** 质检 NG/OK（镜像 result_report.inspection_result） */
function qcResultOf(row: TaskRecord): string | null {
  const report = activityOf(row)?.result_report
  return report?.inspection_result ?? null
}

/** 展开行：完整业务流时间线 */
function timelineOf(row: TaskRecord) {
  const nodes: { kind: string; state: string; title: string; time: number | null; detail: string }[] = []
  const occupied = usageOf(row, 'OCCUPIED')
  nodes.push({
    kind: 'assign', state: occupied ? 'ok' : 'none',
    title: '抢占机器人', time: occupied?.first_at ?? null,
    detail: occupied ? `taskflow ${occupied.new_value}` : '无占用记录（裸下发）',
  })
  nodes.push({
    kind: 'move', state: row.status === 'completed' ? 'ok' : row.status === 'failed' ? 'fail'
        : isFinal(row.status) ? 'none' : 'run',
    title: `调度移动（${zhCategory(row.category)}）`, time: row.updated_at ?? null,
    detail: row.message ?? '',
  })
  const activity = activityOf(row)
  if (activity) {
    nodes.push({
      kind: 'inspect', state: activity.action_status === 3 ? 'ok' : 'fail',
      title: '业务动作（上层应用）', time: activity.robot_reported_ms ?? activity.created_at ?? null,
      detail: activity.result_report?.inspection_result
        ? `检测结果 ${activity.result_report.inspection_result}`
        : `action_status=${activity.action_status ?? '--'}`,
    })
  }
  const released = usageOf(row, 'RELEASED')
  nodes.push({
    kind: 'release', state: released ? 'ok' : 'wait',
    title: '释放机器人', time: released?.first_at ?? null,
    detail: released ? '' : '未释放',
  })
  return nodes
}

function nodeIcon(n: { kind: string }) {
  return { assign: '🔒', move: '🚗', inspect: '🔬', release: '🔓' }[n.kind] ?? '·'
}

/** 质检报文弹窗 */
const reportDlg = reactive({ visible: false, json: '', row: null as TaskRecord | null, result: '' })
function showReport(row: TaskRecord) {
  reportDlg.row = row
  reportDlg.result = qcResultOf(row) ?? '--'
  reportDlg.json = JSON.stringify(activityOf(row)?.result_report ?? {}, null, 2)
  reportDlg.visible = true
}

/** 请求报文弹窗（下发时的原始请求字段：taskflow/template/点位/参数） */
const requestDlg = reactive({ visible: false, json: '', row: null as TaskRecord | null })
function showRequest(row: TaskRecord) {
  requestDlg.row = row
  requestDlg.json = JSON.stringify(row.request_payload, null, 2)
  requestDlg.visible = true
}

/** 取消任务（排队→canceled；执行中→completed+cancellation fork 语义） */
async function cancelTask(row: TaskRecord) {
  if (!row.rmf_task_id) {
    ElMessage.warning('任务尚未受理，无法取消')
    return
  }
  try {
    await schedulerApi.stopTask(row.rmf_task_id)
    ElMessage.success(`已取消 ${row.business_task_id || row.rmf_task_id}`)
    load()
  } catch (e: any) {
    ElMessage.error(`取消失败: ${e?.response?.data?.detail ?? e?.message ?? '未知错误'}`)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const [taskResult, activityResult, usageResult] = await Promise.all([
      schedulerApi.tasks({
        status: filters.value.status || undefined,
        category: filters.value.category || undefined,
        robot_code: filters.value.robot_code || undefined,
        page_num: page.value,
        page_size: pageSize,
      }),
      schedulerApi.activities({ page_num: 1, page_size: 200 }).catch(() => ({ list: [], total: 0 })),
      schedulerApi.robotEvents({ event_type: 'USAGE', page_num: 1, page_size: 200 }).catch(() => ({ list: [], total: 0 })),
    ])
    rows.value = taskResult.list ?? []
    total.value = taskResult.total ?? 0

    const byTask = new Map<string, any>()
    for (const a of activityResult.list ?? []) {
      if (a.body_task_id) byTask.set(a.body_task_id, a)
    }
    activityByTaskId.value = byTask

    const byKey = new Map<string, Record<string, any>>()
    for (const e of usageResult.list ?? []) {
      const tf = e.new_value
      if (!tf || !e.robot_code) continue
      const key = `${e.robot_code}|${tf}`
      const slot = byKey.get(key) ?? {}
      slot[e.reason] = e
      byKey.set(key, slot)
    }
    usageByKey.value = byKey
  } catch (e) { console.warn(e) }
}

onMounted(async () => {
  load()
  timer = setInterval(load, 8000)
  try {
    robots.value = await schedulerApi.robots()
    rememberRobotNames(robots.value)
  } catch { /* 名字映射降级为纯编码 */ }
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; }
.filters { display: flex; gap: 8px; align-items: center; }
.planned-route { margin-bottom: 12px; white-space: normal; overflow-wrap: anywhere; color: #409eff; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }

/* 任务 ID 双行：业务任务（主）/ 内核任务（次） */
.id-cell { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.id-biz { font-size: 12px; color: #303133; font-weight: 500; }
.id-kernel { font-size: 11px; color: #909399; }

.robot-cell { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.robot-name { font-size: 12px; color: #303133; font-weight: 500; }
.robot-code { font-size: 11px; color: #909399; }

.status-cell { display: flex; align-items: center; gap: 4px; }
.cancel-btn { padding: 0 2px; font-size: 12px; }

/* 业务流徽标：🔒 占用 → 移动 → 动作 → 🔓 释放 */
.flow-badges { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.flow-badge { font-size: 13px; }
.flow-arrow { color: #c0c4cc; font-size: 11px; }
.b-on { opacity: 1; }
.b-off { opacity: 0.25; filter: grayscale(1); }
.b-wait { opacity: 0.4; }
.b-ok { color: #67c23a; font-weight: 600; }
.b-fail { color: #f56c6c; font-weight: 600; }

/* 展开行业务流时间线 */
.flow-timeline { display: flex; flex-direction: column; gap: 4px; padding: 4px 12px; }
.flow-node { display: flex; align-items: baseline; gap: 10px; font-size: 12px; line-height: 1.6; }
.node-icon { width: 18px; text-align: center; }
.node-title { min-width: 150px; color: #303133; font-weight: 500; }
.node-time { color: #909399; font-family: Consolas, monospace; font-size: 11px; }
.node-detail { color: #909399; }
.st-ok .node-title { color: #303133; }
.st-fail .node-title { color: #f56c6c; }
.st-run .node-title { color: #409eff; }
.st-none .node-title, .st-none .node-icon { color: #c0c4cc; }
.st-wait .node-title { color: #e6a23c; }

.report-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; color: #303133; }
.report-json {
  background: #f5f7fa; border-radius: 4px; padding: 12px; margin: 0;
  max-height: 60vh; overflow: auto; font-size: 12px; line-height: 1.6; white-space: pre-wrap;
}
</style>
