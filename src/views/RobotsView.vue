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
      <el-table-column label="可派" width="60" align="center">
        <template #default="{ row }">
          <span v-if="row.decommissioned" style="color:#f56c6c;font-size:11px">停用</span>
          <span v-else-if="row.mode === 'running' || row.mode === 'charging'" style="color:#409eff;font-size:11px">执行中</span>
          <span v-else-if="row.dispatchable" style="color:#67c23a;font-size:11px">可派</span>
          <span v-else style="color:#f56c6c;font-size:11px">不可派</span>
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
          <span style="font-size:12px;color:#6062666">({{ fmt(row.pose?.x) }}, {{ fmt(row.pose?.y) }})</span>
        </template>
      </el-table-column>
      <el-table-column label="楼层" prop="rmf_level" width="70" />
      <el-table-column label="车队" prop="fleet_name" width="150" show-overflow-tooltip />
      <el-table-column label="当前任务" prop="rmf_task_id" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span style="color:#909399;font-size:11px">{{ row.rmf_task_id ?? '--' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="任务状态" prop="task_status" width="90">
        <template #default="{ row }">{{ zhStatus(row.task_status) }}</template>
      </el-table-column>
      <el-table-column label="家点" prop="home_point" width="80" />
      <el-table-column label="更新" width="160">
        <template #default="{ row }">
          <span style="color:#909399;font-size:11px">{{ fmtTime(row.updated_at) }}</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
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
  if (b == null) return '#909399'
  if (b < 20) return '#f56c6c'
  if (b < 40) return '#e6a23c'
  return '#67c23a'
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
.robot-two-line .robot-name { font-size: 12px; color: #303133; font-weight: 600; }
.robot-two-line .robot-code { font-size: 11px; color: #909399; }
</style>
