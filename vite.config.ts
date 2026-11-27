import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      // 质检模拟器直连 RMS（模拟上层应用行为；仅 dev 代理，生产由真实上层服务端直连）
      '/rms-api': {
        target: 'http://127.0.0.1:18083',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/rms-api/, ''),
      },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
})
