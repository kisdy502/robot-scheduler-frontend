<template>
  <el-card shadow="never">
    <template #header>
      <div class="card-header">
        <span>任务历史</span>
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
    <el-table :data="records" stripe size="small" :default-sort="{ prop: 'updated_at', order: 'descending' }" max-height="calc(100vh - 200px)">
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
      <el-table-column label="说明" min-width="220">
        <template #default="{ row }">
          <span :style="{ color: row.status === 'failed' ? '#f56c6c' : '#606266', fontSize: '12px' }">{{ row.message ?? '' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="请求" width="60" align="center">
        <template #default="{ row }">
          <el-button v-if="row.request_payload" link type="primary" size="small" @click="showRequest(row)">报文</el-button>
        </template>
      </el-table-column>
      <el-table-column label="质检" width="60" align="center">
        <template #default="{ row }">
          <el-button v-if="row.inspection_result" link type="primary" size="small" @click="showReport(row)">查看</el-button>
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

    <!-- 质检结果报文 -->
    <el-dialog v-model="reportDlg.visible" title="质检结果报文" width="640px" align-center>
      <div class="report-meta" v-if="reportDlg.row">
        <span>{{ reportDlg.row.business_task_id }}</span>
        <el-tag size="small" type="success">{{ zhCategory(reportDlg.row.category) }}</el-tag>
        <span style="color:#909399">{{ fmtTime(reportDlg.row.updated_at) }}</span>
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
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames, robotDisplayName } from '@/utils/robotNames'
import type { TaskRecord, RobotInfo } from '@/types'

const records = ref<TaskRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const filters = ref({ status: '', category: '', robot_code: '' })
const robots = ref<RobotInfo[]>([])

/** 编码 → 名称（注册表兜底：后端名称缓存窗口期不退化为编码） */
function robotName(code: string): string {
  return robotDisplayName(code)
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
  go_to_place: '移动', quality_inspection: '质检', charge: '充电', swap_battery: '换电',
  return_home: '归巢', pause_task: '暂停', resume_task: '恢复', cache_task_context: '缓存',
}

const zhStatus = (s: string) => statusMap[s] ?? s
const zhCategory = (s: string) => categoryMap[s] ?? s
const tagType = (s: string) => tagTypeMap[s] ?? 'info'
const isFinal = (s: string) => s === 'completed' || s === 'failed' || s === 'canceled'
const fmtTime = (ts: number | null) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''

/** 质检报文弹窗 */
const reportDlg = reactive({ visible: false, json: '', row: null as TaskRecord | null })
function showReport(row: TaskRecord) {
  reportDlg.row = row
  reportDlg.json = JSON.stringify(row.inspection_result, null, 2)
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

async function load() {
  try {
    const result = await schedulerApi.tasks({
      status: filters.value.status || undefined,
      category: filters.value.category || undefined,
      robot_code: filters.value.robot_code || undefined,
      page_num: page.value,
      page_size: pageSize,
    })
    records.value = result.list ?? []
    total.value = result.total ?? 0
  } catch (e) { console.warn(e) }
}

onMounted(async () => {
  load()
  try {
    robots.value = await schedulerApi.robots()
    rememberRobotNames(robots.value)
  } catch { /* 名字映射降级为纯编码 */ }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; }
.filters { display: flex; gap: 8px; align-items: center; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }

/* 任务 ID 双行：业务任务（主）/ 内核任务（次） */
.id-cell { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.id-biz { font-size: 12px; color: #303133; font-weight: 500; }
.id-kernel { font-size: 11px; color: #909399; }

/* 机器人：名字为主 + 编码小字（同任务 ID 两行样式） */
.robot-cell { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.robot-name { font-size: 12px; color: #303133; font-weight: 500; }
.robot-code { font-size: 11px; color: #909399; }

/* 状态格：状态 + 取消标记 + 活动任务取消按钮 */
.status-cell { display: flex; align-items: center; gap: 4px; }
.cancel-btn { padding: 0 2px; font-size: 12px; }

/* 质检报文弹窗 */
.report-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; color: #303133; }
.report-json {
  background: #f5f7fa; border-radius: 4px; padding: 12px; margin: 0;
  max-height: 60vh; overflow: auto; font-size: 12px; line-height: 1.6; white-space: pre-wrap;
}
</style>
