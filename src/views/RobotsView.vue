<template>
  <el-card shadow="never">
    <template #header>机器人状态（{{ robots.length }} 台 / {{ onlineCount }} 在线，{{ refreshTime }}）</template>
    <el-table :data="robots" stripe size="small" max-height="calc(100vh - 200px)">
      <el-table-column label="机器人" width="130" fixed="left">
        <template #default="{ row }">
          <div class="robot-two-line">
            <div class="robot-name">{{ robotName(row.robot_code) }}</div>
            <div class="robot-code">{{ row.robot_code }}</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="模式" width="100">
        <template #default="{ row }">
          <el-tag :type="modeType(row.mode)" size="small">{{ zhMode(row.mode) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="停用" width="60" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.decommissioned" type="danger" size="small">停用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <span :style="{ color: row.online_status === 'online' ? '#67c23a' : '#f56c6c' }">
            {{ row.online_status === 'online' ? '● 在线' : '● 离线' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="可派" width="200">
        <template #default="{ row }">
          <span v-if="row.decommissioned" style="color:#f56c6c;font-size:11px">停用</span>
          <span v-else-if="row.mode === 'running' || row.mode === 'charging'" style="color:#409eff;font-size:11px">执行中</span>
          <span v-else-if="row.dispatchable" style="color:#67c23a;font-size:11px">可派</span>
          <el-tooltip v-else :content="row.dispatch_blocked_reason ?? '未知原因'" placement="top">
            <span style="color:#f56c6c;font-size:11px;cursor:help;border-bottom:1px dotted #f56c6c">
              不可派（{{ shortReason(row.dispatch_blocked_reason) }}）
            </span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="使用权" width="200">
        <template #default="{ row }">
          <div v-if="row.owned_by_taskflow" class="own-cell">
            <span class="own-tag" :class="ownStale(row) ? 'own-stale' : ''"
                  :title="'taskflow ' + row.owned_by_taskflow">
              🔒 {{ String(row.owned_by_taskflow).slice(-6) }}（{{ heldText(row.owned_since_ms) }}）
            </span>
            <el-button v-if="ownStale(row) && !row.current_task_id" link type="danger" size="small"
                       @click="openForceRelease(row)">强释</el-button>
          </div>
          <span v-else style="color:var(--rs-text-4);font-size:11px">—</span>
        </template>
      </el-table-column>
      <el-table-column label="电量" width="120">
        <template #default="{ row }">
          <el-progress :percentage="Math.round(row.battery ?? 0)" :stroke-width="12"
            :color="batteryColor(row.battery)" style="width:80px" />
        </template>
      </el-table-column>
      <el-table-column label="位置" width="160">
        <template #default="{ row }">
          <span style="font-size:12px;color:var(--rs-text-2)">({{ fmt(row.pose?.x) }}, {{ fmt(row.pose?.y) }})</span>
        </template>
      </el-table-column>
      <el-table-column label="楼层" prop="rmf_level" width="70" />
      <el-table-column label="车队" prop="fleet_name" width="150" show-overflow-tooltip />
      <el-table-column label="当前任务" prop="rmf_task_id" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span style="color:var(--rs-text-3);font-size:11px">{{ row.rmf_task_id ?? '--' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="任务状态" prop="task_status" width="90">
        <template #default="{ row }">{{ zhStatus(row.task_status) }}</template>
      </el-table-column>
      <el-table-column label="家点" prop="home_point" width="80" />
      <el-table-column label="更新" width="160">
        <template #default="{ row }">
          <span style="color:var(--rs-text-3);font-size:11px">{{ fmtTime(row.updated_at) }}</span>
        </template>
      </el-table-column>
    </el-table>

    <!-- 强制释放确认（运维逃生门：reason 必填审计） -->
    <el-dialog v-model="forceDlg.visible" title="强制释放机器人使用权" width="440px" align-center>
      <div class="force-tip">
        将释放 <b>{{ forceDlg.robot_code }}</b> 的使用权（持有者 taskflow
        {{ String(forceDlg.owned_by ?? '').slice(-6) }}，已持有 {{ heldText(forceDlg.owned_since) }}）。
        释放后该机器人可被其他任务流抢占；操作将记录审计事件。
      </div>
      <el-input v-model="forceDlg.reason" placeholder="必填：释放原因（审计记录）" maxlength="120" show-word-limit />
      <template #footer>
        <el-button @click="forceDlg.visible = false">取消</el-button>
        <el-button type="danger" :disabled="!forceDlg.reason.trim()" :loading="forceDlg.loading"
                   @click="confirmForceRelease">确认强制释放</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames, robotDisplayName } from '@/utils/robotNames'
import type { RobotInfo } from '@/types'

const robots = ref<RobotInfo[]>([])

/** 本页只用名字（注册表兜底：后端名称缓存窗口期不退化为编码） */
function robotName(code: string): string {
  return robotDisplayName(code)
}
const refreshTime = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const onlineCount = computed(() => robots.value.filter(r => r.online_status === 'online').length)

const modeMap: Record<string, string> = {
  idle: '空闲', running: '运行中', charging: '充电中', paused: '暂停', waiting: '等待', error: '故障', unknown: '未知', decommissioned: '停用',
}
const statusMap: Record<string, string> = { underway: '执行中', queued: '排队中', completed: '已完成', failed: '失败', canceled: '已取消' }
const modeTypeMap: Record<string, string> = { idle: 'success', running: 'primary', charging: 'primary', paused: 'warning', error: 'danger', decommissioned: 'danger' }

const zhMode = (m: string) => modeMap[m] ?? m
const zhStatus = (s: string | null) => s ? (statusMap[s] ?? s) : '--'
const modeType = (m: string) => modeTypeMap[m] ?? 'info'
const fmt = (v: number | undefined | null) => (v != null ? Number(v).toFixed(1) : '--')
const fmtTime = (ts: number) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''
const batteryColor = (b: number | null) => {
  if (b == null) return 'var(--rs-text-3)'
  if (b < 20) return '#f56c6c'
  if (b < 40) return '#e6a23c'
  return '#67c23a'
}

/** 不可派原因短文案（tooltip 看全文） */
function shortReason(reason: string | null | undefined): string {
  if (!reason) return '未知'
  if (reason.includes('使用权')) return '使用权占用'
  if (reason.includes('停止确认')) return '停止确认中'
  if (reason.includes('地图不一致')) return '地图不一致'
  if (reason.includes('离图')) return '离图'
  if (reason.includes('移动中')) return '移动中'
  if (reason.includes('离线')) return '离线'
  return reason.length > 6 ? reason.slice(0, 6) + '…' : reason
}

/** 占用持有时长文案 */
function heldText(sinceMs: number | null | undefined): string {
  if (!sinceMs) return '未知'
  const s = Math.floor((Date.now() - sinceMs) / 1000)
  if (s < 90) return `${s} 秒`
  if (s < 5400) return `${(s / 60).toFixed(0)} 分钟`
  return `${(s / 3600).toFixed(1)} 小时`
}

/** 占用疑似孤儿：持有超 10 分钟仍无当前任务（租约看门狗 2 分钟自动回收，>10min 说明看门狗关闭或异常） */
function ownStale(row: RobotInfo): boolean {
  if (!row.owned_since_ms) return false
  return Date.now() - row.owned_since_ms > 10 * 60_000
}

/** 强制释放对话框 */
const forceDlg = reactive({
  visible: false, loading: false,
  robot_code: '', owned_by: '' as string | null, owned_since: null as number | null,
  reason: '',
})
function openForceRelease(row: RobotInfo) {
  forceDlg.robot_code = row.robot_code
  forceDlg.owned_by = row.owned_by_taskflow
  forceDlg.owned_since = row.owned_since_ms
  forceDlg.reason = ''
  forceDlg.visible = true
}
async function confirmForceRelease() {
  forceDlg.loading = true
  try {
    const r = await schedulerApi.forceReleaseRobot(forceDlg.robot_code, forceDlg.reason.trim())
    ElMessage.success(`已强制释放（taskflow ${String(r?.taskflow_id ?? '').slice(-6)}）`)
    forceDlg.visible = false
    load()
  } catch (e: any) {
    ElMessage.error(`强制释放失败: ${e?.response?.data?.detail ?? e?.message ?? '未知错误'}`)
  } finally {
    forceDlg.loading = false
  }
}

async function load() {
  try {
    robots.value = await schedulerApi.robots()
    rememberRobotNames(robots.value)
    refreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) { console.warn(e) }
}

onMounted(() => { load(); timer = setInterval(load, 3000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.robot-two-line { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.robot-two-line .robot-name { font-size: 12px; color: var(--rs-text-1); font-weight: 600; }
.robot-two-line .robot-code { font-size: 11px; color: var(--rs-text-3); }
.own-cell { display: flex; align-items: center; gap: 6px; }
.own-tag { font-size: 11px; color: var(--rs-text-2); background: var(--rs-tag-bg); border-radius: 3px; padding: 1px 6px; white-space: nowrap; }
.own-tag.own-stale { color: #e6a23c; background: rgba(230,162,60,0.14); }
.force-tip { font-size: 12px; color: var(--rs-text-2); line-height: 1.6; margin-bottom: 10px; }
</style>
