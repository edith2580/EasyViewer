import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { FontFamilyOption, ThemeMode, TxtTocPatternRule, ViewerSettings, ViewMode } from '@/types'
import { platformStorage } from '@/services/storage/platformAdapter'

const SETTINGS_STORAGE_KEY = 'viewer_settings_v2'

const DEFAULT_SETTINGS: ViewerSettings = {
  viewMode: 'scroll',
  theme: 'light',
  fontFamily: 'sans',
  fontSize: 18,
  lineHeight: 1.75,
  pageMargin: 32,
  autoSync: true,
  syncEndpoint: '',
  txtTocRules: []
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<ViewerSettings>({ ...DEFAULT_SETTINGS, txtTocRules: [] })
  const isLoaded = ref(false)

  async function initSettings() {
    if (isLoaded.value) return
    const saved = await platformStorage.getItem<Partial<ViewerSettings>>(SETTINGS_STORAGE_KEY, {})
    settings.value = {
      ...DEFAULT_SETTINGS,
      ...saved,
      txtTocRules: Array.isArray(saved.txtTocRules) ? saved.txtTocRules : []
    }
    applyGlobalThemeClass(settings.value.theme)
    isLoaded.value = true
  }

  let lastAppliedTheme: ThemeMode | null = null
  let saveSettingsTimer: ReturnType<typeof setTimeout> | null = null

  function applyGlobalThemeClass(theme: ThemeMode) {
    if (typeof document === 'undefined') return
    if (lastAppliedTheme === theme && document.documentElement.classList.contains(`theme-${theme}`)) {
      return
    }
    lastAppliedTheme = theme
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark', 'theme-sepia', 'dark')
    root.classList.add(`theme-${theme}`)
    if (theme === 'dark') {
      root.classList.add('dark')
    }

    // HTML meta theme-color 및 color-scheme 동적 업데이트
    try {
      let themeMeta = document.querySelector('meta[name="theme-color"]')
      if (!themeMeta) {
        themeMeta = document.createElement('meta')
        themeMeta.setAttribute('name', 'theme-color')
        document.head.appendChild(themeMeta)
      }
      const themeColor = theme === 'dark' ? '#111827' : (theme === 'sepia' ? '#f8f1e3' : '#ffffff')
      themeMeta.setAttribute('content', themeColor)
      root.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
    } catch {
      // Ignore if DOM manipulation fails
    }

    // iOS WebKit 네이티브 브릿지 (상태바 스타일 및 윈도우 UIUserInterfaceStyle 동기화)
    try {
      const iosBridge = (window as any).webkit?.messageHandlers?.easyviewer_theme
      if (iosBridge && typeof iosBridge.postMessage === 'function') {
        iosBridge.postMessage(theme)
      }
    } catch {
      // Ignore if not on iOS WKWebView
    }

    try {
      const androidBridge = (window as any).__EASYVIEWER_ANDROID__
      if (androidBridge && typeof androidBridge.setSystemBarTheme === 'function') {
        androidBridge.setSystemBarTheme(theme)
      }
    } catch {
      // Ignore if not on Android WebView
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

  function addTxtTocRule(input: { prefix: string; suffix: string; closing?: string }) {
    const list = settings.value.txtTocRules ?? []
    const rule: TxtTocPatternRule = {
      id: `toc-rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prefix: input.prefix,
      suffix: input.suffix,
      closing: input.closing || '',
      enabled: true
    }
    settings.value.txtTocRules = [...list, rule]
  }

  function toggleTxtTocRule(id: string) {
    const list = settings.value.txtTocRules ?? []
    settings.value.txtTocRules = list.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r
    )
  }

  function removeTxtTocRule(id: string) {
    const list = settings.value.txtTocRules ?? []
    settings.value.txtTocRules = list.filter((r) => r.id !== id)
  }

  function resetSettings() {
    settings.value = { ...DEFAULT_SETTINGS, txtTocRules: [] }
    applyGlobalThemeClass(settings.value.theme)
  }

  watch(
    settings,
    (newVal) => {
      applyGlobalThemeClass(newVal.theme)
      if (saveSettingsTimer) {
        clearTimeout(saveSettingsTimer)
      }
      const snapshot: ViewerSettings = {
        ...newVal,
        txtTocRules: (newVal.txtTocRules ?? []).map((r) => ({ ...r }))
      }
      saveSettingsTimer = setTimeout(() => {
        platformStorage.setItem(SETTINGS_STORAGE_KEY, snapshot)
      }, 250)
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
    addTxtTocRule,
    toggleTxtTocRule,
    removeTxtTocRule,
    resetSettings
  }
})

