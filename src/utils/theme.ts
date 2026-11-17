import { ref } from 'vue'

/** 全局暗色模式状态（html.dark 驱动 Element Plus 暗色变量 + 自定义 --rs-* 令牌） */
const isDark = ref(false)
let initialized = false

function apply(dark: boolean, persist: boolean) {
  isDark.value = dark
  document.documentElement.classList.toggle('dark', dark)
  if (persist) localStorage.setItem('rs-theme', dark ? 'dark' : 'light')
}

/** 主题初始化（App.vue 挂载时调用一次）：localStorage 记忆 > 系统偏好 */
export function useTheme() {
  if (!initialized) {
    initialized = true
    const saved = localStorage.getItem('rs-theme')
    if (saved === 'dark' || saved === 'light') {
      apply(saved === 'dark', false)
    } else {
      apply(window.matchMedia('(prefers-color-scheme: dark)').matches, false)
    }
  }
  return { isDark, toggleTheme: () => apply(!isDark.value, true) }
}
