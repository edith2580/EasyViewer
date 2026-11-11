<script setup lang="ts">
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { FontFamilyOption, ThemeMode, ViewMode } from '@/types'
import {
  BookOpen,
  ScrollText,
  Sun,
  Moon,
  Coffee,
  RotateCcw,
  Minus,
  Plus,
  X
} from 'lucide-vue-next'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const settingsStore = useSettingsStore()

const viewModes: Array<{ value: ViewMode; label: string }> = [
  { value: 'scroll', label: '세로 스크롤' },
  { value: 'paginated', label: '가로 페이지 넘김' }
]

const themes: Array<{ value: ThemeMode; label: string; bgClass: string }> = [
  { value: 'light', label: '라이트', bgClass: 'bg-white text-slate-900 border-slate-300' },
  { value: 'sepia', label: '세피아', bgClass: 'bg-[#f4ecd8] text-[#433422] border-[#d6c3a5]' },
  { value: 'dark', label: '다크', bgClass: 'bg-slate-900 text-slate-100 border-slate-700' }
]

const fonts: Array<{ value: FontFamilyOption; label: string; previewClass: string }> = [
  { value: 'sans', label: '고딕 (Pretendard)', previewClass: 'font-sans' },
  { value: 'serif', label: '명조 (나눔명조)', previewClass: 'font-serif' },
  { value: 'mono', label: '코딩 (고정폭)', previewClass: 'font-mono' },
  { value: 'system', label: '시스템 기본', previewClass: 'font-sans' }
]
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-start justify-end overflow-y-auto bg-black/40 backdrop-blur-[1px]"
    :style="{
      paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
      paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
      paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
      paddingRight: 'calc(env(safe-area-inset-right, 0px) + 1rem)'
    }"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-sm rounded-2xl border shadow-2xl p-5 transition-all overflow-y-auto"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)',
        color: 'var(--ev-text)',
        maxHeight: 'calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2.5rem)'
      }"
    >
      <div class="flex items-center justify-between pb-3 mb-4 border-b shrink-0" :style="{ borderColor: 'var(--ev-border)' }">
        <h3 class="text-base font-bold tracking-tight">뷰어 보기 옵션</h3>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="p-2 rounded-xl opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all"
            title="기본값 초기화"
            @click="settingsStore.resetSettings()"
          >
            <RotateCcw class="w-4 h-4" />
          </button>
          <button
            type="button"
            class="p-2 rounded-xl opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all"
            title="닫기"
            @click="emit('close')"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="space-y-5 text-sm">
        <!-- 1. 보기 모드 (세로 스크롤 / 가로 페이지 넘김) -->
        <div>
          <label class="block text-xs font-semibold uppercase tracking-wider mb-2 opacity-75">
            페이지 넘김 방식
          </label>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="mode in viewModes"
              :key="mode.value"
              type="button"
              class="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border font-medium transition-all"
              :class="
                settingsStore.settings.viewMode === mode.value
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-500'
                  : 'border-transparent bg-black/5 dark:bg-white/5 opacity-80 hover:opacity-100'
              "
              @click="settingsStore.setViewMode(mode.value)"
            >
              <BookOpen v-if="mode.value === 'paginated'" class="w-4 h-4" />
              <ScrollText v-else class="w-4 h-4" />
              <span>{{ mode.label }}</span>
            </button>
          </div>
        </div>

        <!-- 2. 테마 (라이트 / 세피아 / 다크 모드) -->
        <div>
          <label class="block text-xs font-semibold uppercase tracking-wider mb-2 opacity-75">
            컬러 테마
          </label>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="t in themes"
              :key="t.value"
              type="button"
              class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl border font-medium transition-all"
              :class="[
                t.bgClass,
                settingsStore.settings.theme === t.value
                  ? 'ring-2 ring-indigo-500 font-bold shadow-sm'
                  : 'opacity-80 hover:opacity-100'
              ]"
              @click="settingsStore.setTheme(t.value)"
            >
              <Sun v-if="t.value === 'light'" class="w-4 h-4" />
              <Coffee v-else-if="t.value === 'sepia'" class="w-4 h-4" />
              <Moon v-else class="w-4 h-4" />
              <span>{{ t.label }}</span>
            </button>
          </div>
        </div>

        <!-- 3. 글꼴 종류 -->
        <div>
          <label class="block text-xs font-semibold uppercase tracking-wider mb-2 opacity-75">
            글꼴 종류
          </label>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="f in fonts"
              :key="f.value"
              type="button"
              class="py-2 px-3 rounded-xl border text-left transition-all"
              :class="[
                f.previewClass,
                settingsStore.settings.fontFamily === f.value
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-semibold'
                  : 'border-transparent bg-black/5 dark:bg-white/5 opacity-80 hover:opacity-100'
              ]"
              @click="settingsStore.setFontFamily(f.value)"
            >
              {{ f.label }}
            </button>
          </div>
        </div>

        <!-- 4. 글자 크기 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="text-xs font-semibold uppercase tracking-wider opacity-75">글자 크기</label>
            <span class="text-xs font-mono font-semibold">{{ settingsStore.settings.fontSize }}px</span>
          </div>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="p-2 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10"
              @click="settingsStore.setFontSize(settingsStore.settings.fontSize - 1)"
            >
              <Minus class="w-4 h-4" />
            </button>
            <input
              type="range"
              min="12"
              max="36"
              step="1"
              :value="settingsStore.settings.fontSize"
              class="flex-1 accent-indigo-600"
              @input="settingsStore.setFontSize(Number(($event.target as HTMLInputElement).value))"
            />
            <button
              type="button"
              class="p-2 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10"
              @click="settingsStore.setFontSize(settingsStore.settings.fontSize + 1)"
            >
              <Plus class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- 5. 줄 간격 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="text-xs font-semibold uppercase tracking-wider opacity-75">줄 간격</label>
            <span class="text-xs font-mono font-semibold">{{ settingsStore.settings.lineHeight.toFixed(2) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="p-2 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10"
              @click="settingsStore.setLineHeight(settingsStore.settings.lineHeight - 0.1)"
            >
              <Minus class="w-4 h-4" />
            </button>
            <input
              type="range"
              min="1.2"
              max="2.5"
              step="0.05"
              :value="settingsStore.settings.lineHeight"
              class="flex-1 accent-indigo-600"
              @input="settingsStore.setLineHeight(Number(($event.target as HTMLInputElement).value))"
            />
            <button
              type="button"
              class="p-2 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10"
              @click="settingsStore.setLineHeight(settingsStore.settings.lineHeight + 0.1)"
            >
              <Plus class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- 6. 페이지 여백 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="text-xs font-semibold uppercase tracking-wider opacity-75">좌우 여백</label>
            <span class="text-xs font-mono font-semibold">{{ settingsStore.settings.pageMargin }}px</span>
          </div>
          <input
            type="range"
            min="12"
            max="80"
            step="4"
            :value="settingsStore.settings.pageMargin"
            class="w-full accent-indigo-600"
            @input="settingsStore.setPageMargin(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
    </div>
  </div>
</template>

