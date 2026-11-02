<template>
  <el-config-provider>
    <div class="app-layout">
      <el-aside width="64px" class="app-aside">
        <div class="app-logo" title="调度观测台">
          <el-icon :size="22"><Monitor /></el-icon>
        </div>
        <el-menu router :default-active="route.path" class="app-menu" :collapse="true">
          <el-menu-item index="/map">
            <el-icon><MapLocation /></el-icon>
            <template #title>地图监控</template>
          </el-menu-item>
          <el-menu-item index="/tasks">
            <el-icon><List /></el-icon>
            <template #title>任务历史</template>
          </el-menu-item>
          <el-menu-item index="/robots">
            <el-icon><Cpu /></el-icon>
            <template #title>机器人状态</template>
          </el-menu-item>
          <el-menu-item index="/traffic">
            <el-icon><Guide /></el-icon>
            <template #title>交通占用</template>
          </el-menu-item>
          <el-menu-item index="/events">
            <el-icon><Bell /></el-icon>
            <template #title>事件日志</template>
          </el-menu-item>
          <el-menu-item index="/chargers">
            <el-icon><Lightning /></el-icon>
            <template #title>充电桩</template>
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
</script>

<style scoped>
.app-layout { display: flex; height: 100vh; }
.app-aside {
  background: #fff; border-right: 1px solid #e4e7ed; display: flex; flex-direction: column;
  width: 64px; overflow: visible;
}
.app-logo {
  display: flex; align-items: center; justify-content: center; padding: 16px 0;
  color: #409eff; border-bottom: 1px solid #f0f0f0; cursor: default;
}
.app-menu { border-right: none; flex: 1; }
.app-menu:not(.el-menu--collapse) { width: 64px; }
.app-main { padding: 12px; overflow: auto; background: #f5f7fa; flex: 1; min-width: 0; }
</style>
