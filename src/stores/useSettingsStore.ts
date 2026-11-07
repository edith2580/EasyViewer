import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { FontFamilyOption, ThemeMode, ViewerSettings, ViewMode } from '@/types'
import { platformStorage } from '@/services/storage/platformAdapter'

const SETTINGS_STORAGE_KEY = 'viewer_settings_v1'

const DEFAULT_SETTINGS: ViewerSettings = {
  viewMode: 'paginated',
  theme: 'light',
  fontFamily: 'sans',
  fontSize: 18,
  lineHeight: 1.75,
  pageMargin: 32,
  autoSync: true,
  syncEndpoint: ''
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<ViewerSettings>({ ...DEFAULT_SETTINGS })
  const isLoaded = ref(false)

  async function initSettings() {
    if (isLoaded.value) return
    const saved = await platformStorage.getItem<Partial<ViewerSettings>>(SETTINGS_STORAGE_KEY, {})
    settings.value = {
      ...DEFAULT_SETTINGS,
      ...saved
    }
    applyGlobalThemeClass(settings.value.theme)
    isLoaded.value = true
  }

  function applyGlobalThemeClass(theme: ThemeMode) {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark', 'theme-sepia', 'dark')
    root.classList.add(`theme-${theme}`)
    if (theme === 'dark') {
      root.classList.add('dark')
    }
  }

  function setViewMode(mode: ViewMode) {
    settings.value.viewMode = mode
  }

  function setTheme(theme: ThemeMode) {
    settings.value.theme = theme
    applyGlobalThemeClass(theme)
  }

  function setFontFamily(fontFamily: FontFamilyOption) {
    settings.value.fontFamily = fontFamily
  }

  function setFontSize(size: number) {
    settings.value.fontSize = Math.min(36, Math.max(12, size))
  }

  function setLineHeight(height: number) {
    settings.value.lineHeight = Math.min(2.6, Math.max(1.2, Math.round(height * 100) / 100))
  }

  function setPageMargin(margin: number) {
    settings.value.pageMargin = Math.min(80, Math.max(12, margin))
  }

  function resetSettings() {
    settings.value = { ...DEFAULT_SETTINGS }
    applyGlobalThemeClass(settings.value.theme)
  }

  watch(
    settings,
    async (newVal) => {
      applyGlobalThemeClass(newVal.theme)
      await platformStorage.setItem(SETTINGS_STORAGE_KEY, newVal)
    },
    { deep: true }
  )

  return {
    settings,
    isLoaded,
    initSettings,
    setViewMode,
    setTheme,
    setFontFamily,
    setFontSize,
    setLineHeight,
    setPageMargin,
    resetSettings
  }
})

