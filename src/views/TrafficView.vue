<template>
  <div class="traffic-view">
    <el-row :gutter="12">
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>实时占用（{{ robotCount }} 台占用 / {{ refreshTime }}）</template>
          <div v-if="robotCount === 0" style="color:#909399;padding:20px;text-align:center">当前无占用</div>
          <div v-for="(info, robot) in occupation?.by_robot" :key="robot" class="occ-row">
            <div class="occ-robot">
              <b>{{ robotName(String(robot)) || String(robot).slice(-5) }}</b>
              <span class="occ-code">{{ String(robot) }}</span>
            </div>
            <div class="occ-resources">
              <el-tag v-if="info.waypoint_ids?.length" size="small" type="warning" style="margin-right:4px;margin-bottom:2px" v-for="wp in info.waypoint_ids" :key="wp">
                点 {{ wp }}
              </el-tag>
              <el-tag v-if="info.segment_ids?.length" size="small" type="info" style="margin-bottom:2px" v-for="seg in info.segment_ids.slice(0, 5)" :key="seg">
                段 {{ seg.split('#')[1] }}
              </el-tag>
              <el-tag v-if="info.segment_ids && info.segment_ids.length > 5" size="small" type="info">+{{ info.segment_ids.length - 5 }}</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="14">
        <el-card shadow="never">
          <template #header>交通事件审计</template>
          <div class="audit-toolbar">
            <el-select v-model="filterRobot" size="small" clearable filterable placeholder="全部机器人" style="width:170px" @change="load">
              <el-option v-for="r in robots" :key="r.robot_code" :value="r.robot_code"
                         :label="r.robot_name || r.robot_code" />
            </el-select>
            <el-select v-model="filterAction" size="small" clearable placeholder="全部动作" style="width:100px" @change="load">
              <el-option value="ACQUIRE_SEGMENT" label="占段" />
              <el-option value="ACQUIRE_WAYPOINT" label="占点" />
              <el-option value="RELEASE_SEGMENT" label="释段" />
              <el-option value="RELEASE_WAYPOINT" label="释点" />
            </el-select>
            <el-tag v-if="filterRobot" size="small" type="info" effect="plain">按时间正序（单机排查）</el-tag>
          </div>
          <el-table :data="events" stripe size="small" max-height="calc(100vh - 260px)">
            <el-table-column label="时间" width="160">
              <template #default="{ row }">
                <span style="color:#909399;font-size:11px">{{ row.created_at ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="动作" width="100">
              <template #default="{ row }">
                <el-tag :type="actionStyle(row.action)" size="small">{{ actionLabel(row.action) }}</el-tag>
                <el-tag v-if="row.detail?.message === 'dwell'" size="small" type="info" effect="plain" style="margin-left:2px">驻</el-tag>
              </template>
            </el-table-column>
            <el-table-column v-if="!filterRobot" label="机器人" width="140">
              <template #default="{ row }">
                <div class="robot-two-line">
                  <div class="robot-name">{{ robotName(row.robot_code) }}</div>
                  <div class="robot-code">{{ row.robot_code }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="资源" min-width="200">
              <template #default="{ row }">
                <span style="color:#909399;font-size:11px">{{ row.resource_id ?? '' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { schedulerApi } from '@/api/scheduler'
import { rememberRobotNames, robotDisplayName } from '@/utils/robotNames'
import type { TrafficEvent, RobotInfo } from '@/types'

const occupation = ref<any>(null)
const events = ref<TrafficEvent[]>([])
const robots = ref<RobotInfo[]>([])
const refreshTime = ref('')
const filterRobot = ref('')
const filterAction = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const robotCount = computed(() => occupation.value?.by_robot ? Object.keys(occupation.value.by_robot).length : 0)

/** 审计动作文案/配色（占=蓝系，释=绿系；兼容旧动作值 ACQUIRE/RELEASE/RELEASE_SEGMENTS） */
const ACTION_LABELS: Record<string, string> = {
  ACQUIRE_SEGMENT: '占段', ACQUIRE_WAYPOINT: '占点',
  RELEASE_SEGMENT: '释段', RELEASE_WAYPOINT: '释点',
  ACQUIRE: '占用', RELEASE: '全释', RELEASE_SEGMENTS: '段释',
}
const ACTION_STYLES: Record<string, string> = {
  ACQUIRE_SEGMENT: 'primary', ACQUIRE_WAYPOINT: 'warning', ACQUIRE: 'primary',
  RELEASE_SEGMENT: 'success', RELEASE_WAYPOINT: 'success', RELEASE: 'info', RELEASE_SEGMENTS: 'info',
}
function actionLabel(action: string): string { return ACTION_LABELS[action] ?? action }
function actionStyle(action: string): string { return ACTION_STYLES[action] ?? 'info' }

/** 编码 → 名称（注册表兜底：后端 30s 名称缓存窗口期不退化为编码） */
function robotName(code: string): string {
  return robotDisplayName(code)
}

async function load() {
  try {
    const params: { robot_code?: string; action?: string; page_size?: number } = {}
    if (filterRobot.value) params.robot_code = filterRobot.value
    if (filterAction.value) params.action = filterAction.value
    params.page_size = filterRobot.value ? 50 : 30
    const [occ, evts, bots] = await Promise.all([
      schedulerApi.occupation(),
      schedulerApi.trafficEvents(params),
      schedulerApi.robots(),
    ])
    occupation.value = occ
    // 全局视图 = 最新在前；单机排查 = 时间正序（占→释 配对可读）
    events.value = filterRobot.value ? [...(evts.list ?? [])].reverse() : (evts.list ?? [])
    robots.value = bots
    rememberRobotNames(bots)
    refreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) { console.warn(e) }
}

onMounted(() => { load(); timer = setInterval(load, 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.traffic-view { display: flex; flex-direction: column; gap: 12px; }
.occ-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; }
.occ-row:last-child { border-bottom: none; }
.occ-robot { display: flex; align-items: center; gap: 8px; }
.occ-robot b { font-size: 13px; color: #303133; }
.occ-code { font-size: 11px; color: #909399; }
.occ-resources { display: flex; flex-wrap: wrap; gap: 4px; }
.audit-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.robot-two-line { display: flex; flex-direction: column; gap: 1px; line-height: 1.4; }
.robot-two-line .robot-name { font-size: 12px; color: #303133; font-weight: 500; }
.robot-two-line .robot-code { font-size: 11px; color: #909399; }
</style>
