<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores/useBookStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isDesktopApp, isTauriEnv, platformStorage } from '@/services/storage/platformAdapter'
import type { BookFormat, BookMeta } from '@/types'
import NetworkDownloadModal from '@/components/library/NetworkDownloadModal.vue'
import SyncModal from '@/components/library/SyncModal.vue'
import {
  BookOpen,
  FileText,
  Upload,
  Download,
  RefreshCw,
  Trash2,
  Sun,
  Moon,
  Coffee,
  Search,
  Sparkles,
  CheckCircle2,
  FolderOpen,
  FolderCog,
  RotateCcw
} from 'lucide-vue-next'

const router = useRouter()
const bookStore = useBookStore()
const settingsStore = useSettingsStore()

const fileInputRef = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
let dragDepth = 0
let unlistenTauriDragDrop: (() => void) | null = null
const filterFormat = ref<'all' | BookFormat>('all')
const searchQuery = ref('')
const showDownloadModal = ref(false)
const showSyncModal = ref(false)
const toastMessage = ref('')

// Storage folder (Windows/macOS app only)
const isDesktop = ref(false)
const showStoragePanel = ref(false)
const storageDir = ref('')
const storageIsCustom = ref(false)

async function refreshStorageDir() {
  storageDir.value = await platformStorage.getStorageDir()
  storageIsCustom.value = await platformStorage.isCustomStorageDir()
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function openStorageFolder() {
  try {
    await platformStorage.openStorageDir()
  } catch (err) {
    showToast(`폴더를 열 수 없습니다: ${errorText(err)}`)
  }
}

async function changeStorageFolder() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: storageDir.value || undefined,
      title: '소설 저장 폴더 선택'
    })
    if (!picked || Array.isArray(picked)) return
    await platformStorage.setStorageDir(picked)
    await refreshStorageDir()
    showToast('저장 폴더를 변경했습니다. 이제부터 추가하는 책이 이 폴더에 저장됩니다.')
  } catch (err) {
    showToast(`저장 폴더를 변경할 수 없습니다: ${errorText(err)}`)
  }
}

async function resetStorageFolder() {
  try {
    await platformStorage.setStorageDir(null)
    await refreshStorageDir()
    showToast('기본 저장 폴더로 되돌렸습니다.')
  } catch (err) {
    showToast(`기본 폴더로 되돌릴 수 없습니다: ${errorText(err)}`)
  }
}

/** Trash button: removes the book from the library (and its file, if that option is on). */
async function handleRemoveBook(book: BookMeta) {
  const deleteFile = await bookStore.willDeleteFileOnRemove(book.id)
  if (isDesktop.value && deleteFile) {
    // The file is permanently deleted from a user-visible folder: confirm first.
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog')
      const ok = await ask(
        `'${book.title}'을(를) 서재에서 삭제하고 저장 폴더의 파일도 삭제합니다.\n삭제한 파일은 되돌릴 수 없습니다.`,
        { title: '책 삭제', kind: 'warning', okLabel: '삭제', cancelLabel: '취소' }
      )
      if (!ok) return
    } catch {
      return
    }
  }
  const fileDeleted = await bookStore.removeBook(book.id)
  if (isDesktop.value) {
    showToast(
      fileDeleted
        ? '서재에서 삭제하고 파일도 삭제했습니다.'
        : '서재에서 삭제했습니다. 파일은 저장 폴더에 남아 있습니다.'
    )
  }
}

onMounted(async () => {
  await settingsStore.initSettings()
  await bookStore.initLibrary()

  isDesktop.value = await isDesktopApp()
  if (isDesktop.value) await refreshStorageDir()

  window.addEventListener('dragenter', handleWindowDragEnter)
  window.addEventListener('dragover', handleWindowDragOver)
  window.addEventListener('dragleave', handleWindowDragLeave)
  window.addEventListener('drop', handleWindowDrop)

  if (isTauriEnv()) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      unlistenTauriDragDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          isDragging.value = true
        } else if (payload.type === 'leave') {
          isDragging.value = false
          dragDepth = 0
        } else if (payload.type === 'drop') {
          isDragging.value = false
          dragDepth = 0
          if (payload.paths && payload.paths.length > 0) {
            await processDroppedPaths(payload.paths)
          }
        }
      })
    } catch {
      // HTML5 drag and drop handles it when dragDropEnabled is false
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', handleWindowDragEnter)
  window.removeEventListener('dragover', handleWindowDragOver)
  window.removeEventListener('dragleave', handleWindowDragLeave)
  window.removeEventListener('drop', handleWindowDrop)
  unlistenTauriDragDrop?.()
})

const filteredBooks = computed(() => {
  return bookStore.sortedBooks.filter((book) => {
    if (filterFormat.value !== 'all' && book.format !== filterFormat.value) {
      return false
    }
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.toLowerCase()
      return (
        book.title.toLowerCase().includes(q) ||
        book.author.toLowerCase().includes(q)
      )
    }
    return true
  })
})

function showToast(msg: string) {
  toastMessage.value = msg
  setTimeout(() => {
    if (toastMessage.value === msg) {
      toastMessage.value = ''
    }
  }, 3000)
}

function openBook(book: BookMeta) {
  router.push({ name: 'reader', params: { id: book.id } })
}

async function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  await processFiles(Array.from(input.files))
  input.value = ''
}

function hasFileTransfer(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return true
  return Array.from(types).includes('Files')
}

function handleWindowDragEnter(e: DragEvent) {
  if (!hasFileTransfer(e)) return
  e.preventDefault()
  dragDepth++
  isDragging.value = true
}

function handleWindowDragOver(e: DragEvent) {
  if (!hasFileTransfer(e)) return
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
  isDragging.value = true
}

function handleWindowDragLeave(e: DragEvent) {
  if (!hasFileTransfer(e)) return
  e.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0 || !e.relatedTarget) {
    isDragging.value = false
    dragDepth = 0
  }
}

async function handleWindowDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  isDragging.value = false
  if (e.dataTransfer?.files?.length) {
    await processFiles(Array.from(e.dataTransfer.files))
  }
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragDepth = 0
  isDragging.value = false
  if (!e.dataTransfer?.files?.length) return
  await processFiles(Array.from(e.dataTransfer.files))
}

async function processDroppedPaths(paths: string[]) {
  let added = 0
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    for (const fullPath of paths) {
      const normalized = fullPath.replace(/\\/g, '/')
      const fileName = normalized.split('/').pop() || fullPath
      const lower = fileName.toLowerCase()
      if (!lower.endsWith('.txt') && !lower.endsWith('.epub')) continue
      const bytes = await readFile(fullPath)
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      // Passing the path lets a file that already is in the storage folder be used in place.
      await bookStore.addBookFromBuffer(buffer, fileName, undefined, undefined, fullPath)
      added++
    }
  } catch (err) {
    console.warn('[LibraryView] Tauri path drop read failed:', err)
  }

  if (added > 0) {
    showToast(`${added}권의 문서를 오프라인 서재에 추가했습니다.`)
  } else {
    showToast('지원하는 파일 형식(.txt, .epub)을 선택해 주세요.')
  }
}

async function processFiles(files: File[]) {
  let added = 0
  for (const file of files) {
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.txt') && !lower.endsWith('.epub')) continue
    const buffer = await file.arrayBuffer()
    await bookStore.addBookFromBuffer(buffer, file.name)
    added++
  }
  if (added > 0) {
    showToast(`${added}권의 문서를 오프라인 서재에 추가했습니다.`)
  } else {
    showToast('지원하는 파일 형식(.txt, .epub)을 선택해 주세요.')
  }
}

function cycleTheme() {
  const order: Array<'light' | 'sepia' | 'dark'> = ['light', 'sepia', 'dark']
  const idx = order.indexOf(settingsStore.settings.theme)
  const next = order[(idx + 1) % order.length]
  settingsStore.setTheme(next)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
</script>

<template>
  <div
    class="h-full w-full flex flex-col overflow-hidden select-none"
    @dragover.prevent="handleWindowDragOver"
    @drop.prevent="handleDrop"
  >
    <!-- Header -->
    <header
      class="px-4 sm:px-8 pb-4 border-b flex flex-wrap items-center justify-between gap-3 shrink-0"
      :style="{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)'
      }"
    >
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/20">
          <BookOpen class="w-5 h-5" />
        </div>
        <div>
          <h1 class="text-lg font-extrabold tracking-tight flex items-center gap-2">
            <span>EasyViewer</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              TXT · EPUB
            </span>
          </h1>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-2">
        <input
          ref="fileInputRef"
          type="file"
          accept=".txt,.epub"
          multiple
          class="hidden"
          @change="handleFileSelect"
        />

        <button
          type="button"
          class="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition-all"
          @click="fileInputRef?.click()"
        >
          <Upload class="w-4 h-4" />
          <span>파일 열기</span>
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
          :style="{ borderColor: 'var(--ev-border)' }"
          @click="showDownloadModal = true"
        >
          <Download class="w-4 h-4 text-indigo-500" />
          <span>다운로드</span>
        </button>

        <!-- Storage folder: open in Explorer/Finder or change it (desktop app only) -->
        <div v-if="isDesktop" class="relative">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
            :style="{ borderColor: showStoragePanel ? '#6366f1' : 'var(--ev-border)' }"
            title="소설 저장 폴더"
            :aria-expanded="showStoragePanel"
            @click="showStoragePanel = !showStoragePanel"
          >
            <FolderOpen class="w-4 h-4 text-indigo-500" />
            <span>저장 폴더</span>
          </button>

          <template v-if="showStoragePanel">
            <div class="fixed inset-0 z-30" @click="showStoragePanel = false" />
            <div
              class="absolute right-0 top-full mt-2 z-40 w-80 max-w-[calc(100vw-2rem)] p-4 rounded-2xl border shadow-xl"
              :style="{ backgroundColor: 'var(--ev-surface)', borderColor: 'var(--ev-border)' }"
            >
              <p class="text-xs font-bold mb-1.5">
                소설 저장 폴더
                <span
                  class="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/10 opacity-70"
                >
                  {{ storageIsCustom ? '사용자 지정' : '기본' }}
                </span>
              </p>
              <p
                class="text-[11px] font-mono break-all leading-relaxed px-2.5 py-2 rounded-lg bg-black/5 dark:bg-white/5 select-text"
                :title="storageDir"
              >
                {{ storageDir }}
              </p>

              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all"
                  @click="openStorageFolder"
                >
                  <FolderOpen class="w-4 h-4" />
                  <span>폴더 열기</span>
                </button>
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
                  :style="{ borderColor: 'var(--ev-border)' }"
                  @click="changeStorageFolder"
                >
                  <FolderCog class="w-4 h-4 text-indigo-500" />
                  <span>폴더 변경</span>
                </button>
                <button
                  v-if="storageIsCustom"
                  type="button"
                  class="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
                  :style="{ borderColor: 'var(--ev-border)' }"
                  @click="resetStorageFolder"
                >
                  <RotateCcw class="w-4 h-4 opacity-70" />
                  <span>기본 폴더로</span>
                </button>
              </div>

              <p class="mt-3 text-[11px] leading-relaxed opacity-60">
                폴더를 변경하면 이후 추가하는 책부터 새 폴더에 저장됩니다. 이미 추가한 책은 원래
                폴더에 그대로 남아 있습니다.
              </p>

              <label
                class="mt-3 pt-3 border-t flex items-start gap-2.5 cursor-pointer select-none"
                :style="{ borderColor: 'var(--ev-border)' }"
              >
                <input
                  type="checkbox"
                  class="mt-0.5 w-4 h-4 shrink-0 accent-indigo-600 cursor-pointer"
                  :checked="bookStore.deleteFileOnRemove"
                  @change="
                    bookStore.setDeleteFileOnRemove(($event.target as HTMLInputElement).checked)
                  "
                />
                <span class="text-xs leading-relaxed">
                  <span class="font-semibold">서재에서 삭제할 때 파일도 삭제</span>
                  <span class="block text-[11px] opacity-60">
                    끄면 서재 목록에서만 빠지고 파일은 저장 폴더에 남습니다.
                  </span>
                </span>
              </label>
            </div>
          </template>
        </div>

        <button
          v-show="false"
          type="button"
          class="hidden items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
          :style="{ borderColor: 'var(--ev-border)' }"
          title="마지막 읽은 페이지 동기화"
          @click="showSyncModal = true"
        >
          <RefreshCw class="w-4 h-4 text-indigo-500" :class="{ 'animate-spin': bookStore.isSyncing }" />
          <span class="hidden sm:inline">동기화</span>
        </button>

        <button
          type="button"
          class="p-2 rounded-xl border hover:border-indigo-500 transition-all"
          :style="{ borderColor: 'var(--ev-border)' }"
          :title="`현재 테마: ${settingsStore.settings.theme.toUpperCase()} (클릭하여 전환)`"
          @click="cycleTheme"
        >
          <Sun v-if="settingsStore.settings.theme === 'light'" class="w-4 h-4 text-amber-500" />
          <Coffee v-else-if="settingsStore.settings.theme === 'sepia'" class="w-4 h-4 text-amber-800" />
          <Moon v-else class="w-4 h-4 text-indigo-400" />
        </button>
      </div>
    </header>

    <!-- Sub-toolbar: Filter & Search -->
    <div class="px-4 sm:px-8 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
      <div class="flex items-center gap-1.5 p-1 rounded-xl bg-black/5 dark:bg-white/5">
        <button
          v-for="tab in ([
            { key: 'all', label: '전체 문서' },
            { key: 'epub', label: 'EPUB' },
            { key: 'txt', label: 'TXT' }
          ] as const)"
          :key="tab.key"
          type="button"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          :class="
            filterFormat === tab.key
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'opacity-70 hover:opacity-100'
          "
          @click="filterFormat = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="relative w-full sm:w-64">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="서재 내 제목·저자 검색..."
          class="w-full pl-9 pr-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
          :style="{ borderColor: 'var(--ev-border)' }"
        />
      </div>
    </div>

    <!-- Main Library Grid -->
    <main
      class="flex-1 overflow-y-auto px-4 sm:px-8 pb-10"
      :style="{
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2.5rem)'
      }"
    >
      <!-- Empty state -->
      <div
        v-if="filteredBooks.length === 0"
        class="h-80 rounded-3xl border-2 border-dashed flex flex-col items-center justify-center text-center p-6"
        :style="{ borderColor: 'var(--ev-border)' }"
      >
        <BookOpen class="w-12 h-12 mb-3 opacity-30" />
        <p class="text-sm font-semibold mb-1">표시할 문서가 없습니다</p>
        <p class="text-xs opacity-60 mb-4">
          컴퓨터/기기의 .txt, .epub 파일을 끌어다 놓거나 샘플 문서를 불러오세요.
        </p>
        <button
          type="button"
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
          @click="bookStore.seedSampleBooks()"
        >
          <Sparkles class="w-4 h-4" />
          <span>기본 샘플 북(EPUB & TXT) 다시 생성</span>
        </button>
      </div>

      <!-- Book Cards Grid -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <div
          v-for="book in filteredBooks"
          :key="book.id"
          class="group relative rounded-2xl border p-4 flex flex-col justify-between transition-all hover:-translate-y-0.5 hover:shadow-lg hover:border-indigo-500/60 cursor-pointer"
          :style="{
            backgroundColor: 'var(--ev-surface)',
            borderColor: 'var(--ev-border)'
          }"
          @click="openBook(book)"
        >
          <div>
            <!-- Format Badge & Delete -->
            <div class="flex items-center justify-between gap-2 mb-3">
              <div class="flex items-center gap-1.5">
                <span
                  class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide"
                  :class="
                    book.format === 'epub'
                      ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                      : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  "
                >
                  <BookOpen v-if="book.format === 'epub'" class="w-3 h-3" />
                  <FileText v-else class="w-3 h-3" />
                  {{ book.format }}
                </span>

                <span
                  v-if="book.isOfflineCached"
                  class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 opacity-75"
                  title="오프라인 읽기 가능"
                >
                  <CheckCircle2 class="w-3 h-3 text-emerald-500" />
                  오프라인
                </span>
              </div>

              <button
                type="button"
                class="p-1.5 rounded-lg opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-all"
                :title="
                  isDesktop && book.storedPath
                    ? bookStore.deleteFileOnRemove
                      ? '서재에서 삭제 (파일도 삭제)'
                      : '서재에서 삭제 (파일은 유지)'
                    : '서재에서 삭제'
                "
                @click.stop="handleRemoveBook(book)"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>

            <!-- Title & Author -->
            <h2 class="text-base font-bold line-clamp-2 mb-1 group-hover:text-indigo-500 transition-colors">
              {{ book.title }}
            </h2>
            <p class="text-xs opacity-65 truncate mb-4">
              {{ book.author }} · {{ formatFileSize(book.fileSize) }}
            </p>
          </div>

          <!-- Reading Progress Footer -->
          <div class="pt-3 border-t" :style="{ borderColor: 'var(--ev-border)' }">
            <div class="flex items-center justify-between text-xs mb-1.5">
              <span class="truncate opacity-75 max-w-[70%]">
                {{ book.lastLocation?.chapterTitle || '읽기 전' }}
              </span>
              <span class="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                {{ (book.lastLocation?.percentage ?? 0).toFixed(1) }}%
              </span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
              <div
                class="h-full bg-indigo-600 rounded-full transition-all duration-300"
                :style="{ width: `${book.lastLocation?.percentage ?? 0}%` }"
              />
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Drag & Drop Overlay -->
    <div
      v-if="isDragging"
      class="fixed inset-0 z-50 bg-indigo-600/20 backdrop-blur-xs border-4 border-dashed border-indigo-500 flex items-center justify-center pointer-events-none"
    >
      <div class="px-8 py-6 rounded-2xl bg-slate-900 text-white shadow-2xl flex items-center gap-3">
        <Upload class="w-6 h-6 text-indigo-400 animate-bounce" />
        <span class="text-base font-bold">여기에 .TXT 또는 .EPUB 파일을 놓아 서재에 추가하세요</span>
      </div>
    </div>

    <!-- Toast Notification -->
    <div
      v-if="toastMessage"
      class="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-medium shadow-xl"
    >
      {{ toastMessage }}
    </div>

    <!-- Modals -->
    <NetworkDownloadModal
      :open="showDownloadModal"
      @close="showDownloadModal = false"
      @downloaded="(b) => showToast(`'${b.title}' 다운로드 및 오프라인 저장 완료!`)"
    />

    <SyncModal
      :open="showSyncModal"
      @close="showSyncModal = false"
    />
  </div>
</template>

