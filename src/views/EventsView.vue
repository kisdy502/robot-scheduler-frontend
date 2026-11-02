<template>
  <div class="events-view">
    <el-card shadow="never">
      <template #header>
        <div class="events-header">
          <span>机器人事件日志（{{ total }} 条 / {{ refreshTime }}）</span>
          <div class="events-filters">
            <el-select v-model="filters.robot_code" clearable filterable placeholder="全部机器人" size="small" style="width:170px" @change="load">
              <el-option v-for="r in robots" :key="r.robot_code" :value="r.robot_code"
                         :label="r.robot_name || r.robot_code" />
            </el-select>
            <el-select v-model="filters.event_type" clearable placeholder="全部类型" size="small" style="width:110px" @change="load">
              <el-option value="MODE" label="状态" />
              <el-option value="BATTERY" label="电量" />
              <el-option value="ONLINE" label="上下线" />
              <el-option value="GRAPH" label="离图" />
              <el-option value="MAP" label="地图" />
            </el-select>
            <el-select v-model="filters.severity" clearable placeholder="全部级别" size="small" style="width:100px" @change="load">
              <el-option value="INFO" label="INFO" />
              <el-option value="WARN" label="WARN" />
              <el-option value="ERROR" label="ERROR" />
            </el-select>
          </div>
        </div>
      </template>

      <el-table :data="events" stripe size="small" max-height="calc(100vh - 210px)">
        <el-table-column label="时间" width="250">
          <template #default="{ row }">
            <div class="time-cell">
              <span>{{ fmt(row.last_at) }}</span>
              <span v-if="row.count > 1" class="time-agg">
                自 {{ fmt(row.first_at) }} 聚合 {{ row.count }} 次
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="机器人" width="150">
          <template #default="{ row }">
            <div class="robot-two-line">
              <div class="robot-name">{{ robotName(row.robot_code) }}</div>
              <div class="robot-code">{{ row.robot_code }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.event_type === 'MODE' ? 'primary' : row.event_type === 'BATTERY' ? 'warning' : row.event_type === 'GRAPH' ? 'danger' : 'info'">
              {{ typeLabel(row.event_type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.severity === 'ERROR' ? 'danger' : row.severity === 'WARN' ? 'warning' : 'info'">
              {{ row.severity }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="变化" width="150">
          <template #default="{ row }">
            <span class="change-cell">
              <span v-if="row.old_value">{{ row.old_value }}</span>
              <span v-if="row.old_value" class="change-arrow">→</span>
              <b>{{ row.new_value }}</b>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="220">
          <template #default="{ row }">
            <span>{{ row.message }}</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="events-pager">
        <el-pagination layout="prev, pager, next, total" :total="total" :page-size="pageSize"
                       :current-page="pageNum" small @current-change="onPage" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ElNotification } from 'element-plus'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames, robotDisplayName } from '@/utils/robotNames'
import type { RobotEvent, RobotInfo } from '@/types'

const events = ref<RobotEvent[]>([])
const robots = ref<RobotInfo[]>([])
const total = ref(0)
const refreshTime = ref('')
const filters = ref<{ robot_code?: string; event_type?: string; severity?: string }>({})
const pageNum = ref(1)
const pageSize = 30
let timer: ReturnType<typeof setInterval> | null = null
/** 已见最大事件 id：WARN/ERROR 新事件实时 toast */
let maxSeenId = 0

function robotName(code: string): string {
  return robotDisplayName(code)
}

function typeLabel(type: string): string {
  return type === 'MODE' ? '状态' : type === 'BATTERY' ? '电量' : type === 'ONLINE' ? '上下线'
    : type === 'GRAPH' ? '离图' : type === 'MAP' ? '地图' : type
}

function fmt(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''
}

async function load() {
  try {
    const [page, bots] = await Promise.all([
      schedulerApi.robotEvents({ ...filters.value, page_num: pageNum.value, page_size: pageSize }),
      schedulerApi.robots(),
    ])
    events.value = page.list ?? []
    total.value = page.total ?? 0
    robots.value = bots
    rememberRobotNames(bots)
    refreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    notifyNewAlerts(events.value)
  } catch (e) { console.warn(e) }
}

/** 首屏只记水位不弹窗；之后新出现的 WARN/ERROR 弹通知 */
function notifyNewAlerts(list: RobotEvent[]) {
  const ids = list.map(e => Number(e.id)).filter(n => Number.isFinite(n))
  if (ids.length === 0) return
  const maxId = Math.max(...ids)
  if (maxSeenId === 0) {
    maxSeenId = maxId
    return
  }
  const alerts = list.filter(e => Number(e.id) > maxSeenId && (e.severity === 'WARN' || e.severity === 'ERROR'))
  for (const a of alerts.slice(0, 3)) {
    ElNotification({
      title: `${a.severity} · ${robotName(a.robot_code) || a.robot_code}`,
      message: a.message ?? '',
      type: a.severity === 'ERROR' ? 'error' : 'warning',
      duration: 6000,
      position: 'bottom-right',
    })
  }
  maxSeenId = Math.max(maxSeenId, maxId)
}

function onPage(p: number) {
  pageNum.value = p
  load()
}

onMounted(() => { load(); timer = setInterval(load, 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.events-view { display: flex; flex-direction: column; gap: 12px; }
.events-header { display: flex; align-items: center; justify-content: space-between; }
.events-filters { display: flex; gap: 8px; }
.time-cell { display: flex; flex-direction: column; }
.time-agg { font-size: 11px; color: #909399; }
.change-cell { font-size: 12px; color: #606266; }
.change-arrow { margin: 0 4px; color: #c0c4cc; }
.events-pager { display: flex; justify-content: flex-end; margin-top: 10px; }
.robot-two-line { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.robot-two-line .robot-name { font-size: 12px; color: #303133; font-weight: 500; }
.robot-two-line .robot-code { font-size: 11px; color: #909399; }
</style>
