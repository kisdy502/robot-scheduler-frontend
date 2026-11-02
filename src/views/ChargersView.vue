<template>
  <el-card shadow="never">
    <template #header>充电桩（{{ chargers.length }} 个 / {{ availableCount }} 可用，{{ refreshTime }}）</template>
    <el-table :data="chargers" stripe size="small">
      <el-table-column label="桩 ID" prop="charger_id" width="120" fixed="left" />
      <el-table-column label="名称" prop="name" width="140" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="row.resource_type === 'swap_station' ? 'warning' : 'primary'" size="small">
            {{ row.resource_type === 'swap_station' ? '换电' : '充电' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="楼层" prop="rmf_level" width="70" />
      <el-table-column label="点位" prop="waypoint" width="100" />
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.status === 0 ? 'success' : row.status === 1 ? 'warning' : 'danger'" size="small">
            {{ row.status === 0 ? '可用' : row.status === 1 ? '占用' : '异常' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="占用者" width="130">
        <template #default="{ row }">
          <span v-if="row.occupied_by">{{ row.occupied_by }}</span>
          <span v-else style="color:#c0c4cc">--</span>
        </template>
      </el-table-column>
      <el-table-column label="启用" width="60" align="center">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small" circle>{{ row.enabled ? '✓' : '✗' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新" width="160">
        <template #default="{ row }">
          <span style="color:#909399;font-size:11px">{{ row.updated_at ? new Date(row.updated_at).toLocaleString('zh-CN', { hour12: false }) : '' }}</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { schedulerApi } from '@/api/scheduler'
import type { ChargerInfo } from '@/types'

const chargers = ref<ChargerInfo[]>([])
const refreshTime = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const availableCount = computed(() => chargers.value.filter(c => c.status === 0).length)

async function load() {
  try {
    chargers.value = await schedulerApi.chargers()
    refreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) { console.warn(e) }
}

onMounted(() => { load(); timer = setInterval(load, 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>
