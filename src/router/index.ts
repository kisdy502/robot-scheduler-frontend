import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/map' },
    { path: '/map', name: 'map', component: () => import('@/views/MapView.vue') },
    { path: '/tasks', name: 'tasks', component: () => import('@/views/TasksView.vue') },
    { path: '/robots', name: 'robots', component: () => import('@/views/RobotsView.vue') },
    { path: '/traffic', name: 'traffic', component: () => import('@/views/TrafficView.vue') },
    { path: '/events', name: 'events', component: () => import('@/views/EventsView.vue') },
    { path: '/chargers', name: 'chargers', component: () => import('@/views/ChargersView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/map' },
  ],
})
export default router
