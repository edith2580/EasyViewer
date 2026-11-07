<script setup lang="ts">
import { ref } from 'vue'
import { useBookStore } from '@/stores/useBookStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { RefreshCw, Cloud, Copy, Upload, Check, X } from 'lucide-vue-next'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const bookStore = useBookStore()
const settingsStore = useSettingsStore()

const syncSnapshotJson = ref('')
const feedbackMsg = ref('')
const copied = ref(false)

async function handleRunSync() {
  feedbackMsg.value = ''
  const res = await bookStore.syncNow()
  feedbackMsg.value = res.message
}

async function handleExportJson() {
  syncSnapshotJson.value = await bookStore.exportSyncSnapshot()
  try {
    await navigator.clipboard.writeText(syncSnapshotJson.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // Ignore clipboard permission issue
  }
  feedbackMsg.value = '현재 기기의 독서 위치·책갈피 동기화 스냅샷을 생성했습니다.'
}

async function handleImportJson() {
  if (!syncSnapshotJson.value.trim()) return
  try {
    const count = await bookStore.importSyncSnapshot(syncSnapshotJson.value)
    feedbackMsg.value = `동기화 데이터를 성공적으로 병합했습니다 (${count}권의 마지막 읽은 페이지 갱신).`
  } catch (err: any) {
    feedbackMsg.value = err?.message || '동기화 JSON 파싱에 실패했습니다.'
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-lg rounded-2xl border shadow-2xl p-6 space-y-4"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)',
        color: 'var(--ev-text)'
      }"
    >
      <div class="flex items-center justify-between pb-3 border-b" :style="{ borderColor: 'var(--ev-border)' }">
        <div class="flex items-center gap-2">
          <Cloud class="w-5 h-5 text-indigo-500" />
          <h3 class="text-base font-bold">마지막 읽은 페이지 및 책갈피 동기화</h3>
        </div>
        <button
          type="button"
          class="p-1.5 rounded-lg opacity-70 hover:opacity-100"
          @click="emit('close')"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="space-y-4 text-sm">
        <!-- Remote Sync Server Endpoint -->
        <div>
          <label class="block text-xs font-semibold mb-1 opacity-80">
            원격 동기화 서버 엔드포인트 (선택 사항)
          </label>
          <div class="flex gap-2">
            <input
              v-model="settingsStore.settings.syncEndpoint"
              type="url"
              placeholder="https://api.example.com/easyviewer/sync (비워두면 로컬 허브 사용)"
              class="flex-1 px-3 py-2 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
              :style="{ borderColor: 'var(--ev-border)' }"
            />
            <button
              type="button"
              :disabled="bookStore.isSyncing"
              class="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shrink-0 transition-colors"
              @click="handleRunSync"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': bookStore.isSyncing }" />
              <span>지금 동기화</span>
            </button>
          </div>
        </div>

        <!-- Cross-device JSON Snapshot Export / Import -->
        <div class="pt-2 border-t" :style="{ borderColor: 'var(--ev-border)' }">
          <div class="flex items-center justify-between mb-1.5">
            <label class="text-xs font-semibold opacity-80">
              기기 간 동기화 스냅샷 (JSON 내보내기 / 가져오기)
            </label>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs hover:border-indigo-500"
                :style="{ borderColor: 'var(--ev-border)' }"
                @click="handleExportJson"
              >
                <Check v-if="copied" class="w-3.5 h-3.5 text-emerald-500" />
                <Copy v-else class="w-3.5 h-3.5" />
                <span>{{ copied ? '복사됨' : '내보내기' }}</span>
              </button>
              <button
                type="button"
                class="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs hover:border-indigo-500"
                :style="{ borderColor: 'var(--ev-border)' }"
                @click="handleImportJson"
              >
                <Upload class="w-3.5 h-3.5" />
                <span>가져와서 병합</span>
              </button>
            </div>
          </div>
          <textarea
            v-model="syncSnapshotJson"
            rows="5"
            placeholder="내보내기 버튼을 누르면 현재 모든 책의 마지막 읽은 위치(CFI/오프셋)와 책갈피가 JSON으로 출력됩니다. 다른 기기에서 붙여넣고 '가져와서 병합'을 누르면 타임스탬프 기준으로 최신 위치가 반영됩니다."
            class="w-full p-3 rounded-xl border text-xs font-mono bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
            :style="{ borderColor: 'var(--ev-border)' }"
          />
        </div>

        <div
          v-if="feedbackMsg"
          class="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-600 dark:text-indigo-300 text-xs font-medium"
        >
          {{ feedbackMsg }}
        </div>
      </div>
    </div>
  </div>
</template>

