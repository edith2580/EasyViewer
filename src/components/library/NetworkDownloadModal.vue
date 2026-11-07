<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores/useBookStore'
import type { BookMeta, WebDavConnection, WebDavItem } from '@/types'
import {
  downloadWebDavFile,
  listWebDavDirectory,
  loadWebDavHistory,
  removeWebDavConnection,
  saveWebDavConnection
} from '@/services/network/webdavService'
import {
  ArrowLeft,
  Globe,
  Server,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  Folder,
  FileText,
  BookOpen,
  Trash2,
  Clock,
  CornerLeftUp,
  RefreshCw,
  Plus,
  Search,
  ArrowUp,
  ArrowDown,
  ArrowUpDown
} from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  initialTab?: 'url' | 'webdav'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'downloaded', book: BookMeta): void
}>()

const router = useRouter()
const bookStore = useBookStore()

const activeTab = ref<'url' | 'webdav'>(props.initialTab || 'url')

// 1. Direct URL Download State
const remoteUrl = ref('')
const isDownloading = ref(false)
const progressPercent = ref(0)
const errorMessage = ref('')

// 2. WebDAV Connection & History State
const webdavUrl = ref('')
const webdavPath = ref('/')
const webdavUsername = ref('')
const webdavPassword = ref('')
const webdavHistory = ref<WebDavConnection[]>([])

// 3. Full-Screen WebDAV Explorer State (shown as a new Full Screen upon connection success)
const isWebDavConnecting = ref(false)
const isWebDavExplorerOpen = ref(false)
const currentBrowsePath = ref('/')
const webdavItems = ref<WebDavItem[]>([])
const explorerSearchQuery = ref('')
const explorerSortKey = ref<'name' | 'date' | 'size'>('name')
const explorerSortOrder = ref<'asc' | 'desc'>('asc')
const downloadingItemPath = ref('')
const downloadedPaths = ref<Set<string>>(new Set())
const webdavError = ref('')
const webdavSuccessMsg = ref('')
const explorerToast = ref('')

function toggleExplorerSort(key: 'name' | 'date' | 'size') {
  if (explorerSortKey.value === key) {
    explorerSortOrder.value = explorerSortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    explorerSortKey.value = key
    explorerSortOrder.value = key === 'name' ? 'asc' : 'desc'
  }
}

function getItemTimestamp(rawDate?: string): number {
  if (!rawDate) return 0
  const parsed = Date.parse(rawDate)
  return Number.isNaN(parsed) ? 0 : parsed
}

const activeServerLabel = computed(() => {
  try {
    return new URL(webdavUrl.value.trim()).host
  } catch {
    return webdavUrl.value.trim() || 'WebDAV 서버'
  }
})

const currentFolderName = computed(() => {
  const parts = currentBrowsePath.value.split('/').filter(Boolean)
  if (parts.length > 0) {
    return parts[parts.length - 1]
  }
  try {
    const urlParts = decodeURIComponent(new URL(webdavUrl.value.trim()).pathname)
      .split('/')
      .filter(Boolean)
    if (urlParts.length > 0) {
      return urlParts[urlParts.length - 1]
    }
  } catch {
    // ignore URL parse error
  }
  return '루트 (/)'
})

const filteredWebdavItems = computed(() => {
  const q = explorerSearchQuery.value.trim().toLowerCase()
  const baseList = q
    ? webdavItems.value.filter((item) => item.name.toLowerCase().includes(q))
    : [...webdavItems.value]

  const key = explorerSortKey.value
  const dir = explorerSortOrder.value === 'asc' ? 1 : -1

  return baseList.sort((a, b) => {
    // Keep folders above files
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }

    let cmp = 0
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
    } else if (key === 'date') {
      cmp = getItemTimestamp(a.lastModified) - getItemTimestamp(b.lastModified)
      if (cmp === 0) {
        cmp = a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
      }
    } else if (key === 'size') {
      cmp = (a.size || 0) - (b.size || 0)
      if (cmp === 0) {
        cmp = a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
      }
    }

    return cmp * dir
  })
})

const folderCount = computed(() => filteredWebdavItems.value.filter((i) => i.isDirectory).length)
const fileCount = computed(() => filteredWebdavItems.value.filter((i) => !i.isDirectory).length)

function showExplorerToast(msg: string) {
  explorerToast.value = msg
  setTimeout(() => {
    if (explorerToast.value === msg) {
      explorerToast.value = ''
    }
  }, 3000)
}

watch(
  () => [props.open, props.initialTab] as const,
  async ([isOpen, tab]) => {
    if (isOpen) {
      if (tab) {
        activeTab.value = tab
      }
      errorMessage.value = ''
      webdavError.value = ''
      webdavSuccessMsg.value = ''
      isWebDavExplorerOpen.value = false
      webdavHistory.value = await loadWebDavHistory()
    }
  }
)

onMounted(async () => {
  webdavHistory.value = await loadWebDavHistory()
})

async function handleUrlDownload() {
  if (!remoteUrl.value.trim() || isDownloading.value) return
  errorMessage.value = ''
  isDownloading.value = true
  progressPercent.value = 5

  try {
    const book = await bookStore.importFromUrl(remoteUrl.value, (prog) => {
      progressPercent.value = prog.percent
    })
    remoteUrl.value = ''
    emit('downloaded', book)
    emit('close')
  } catch (err: any) {
    errorMessage.value =
      err?.message || '원격 파일 다운로드 중 오류가 발생했습니다. CORS 정책 또는 URL을 확인해 주세요.'
  } finally {
    isDownloading.value = false
  }
}

async function handleSaveWebDavOnly() {
  const url = webdavUrl.value.trim()
  if (!url) {
    webdavError.value = 'WebDAV 서버 URL을 입력해 주세요.'
    return
  }
  webdavError.value = ''
  webdavHistory.value = await saveWebDavConnection({
    alias: '',
    url,
    username: webdavUsername.value.trim(),
    password: webdavPassword.value,
    initialPath: webdavPath.value.trim() || '/'
  })
  webdavSuccessMsg.value = '최근 접속내역 목록에 연결 정보를 저장했습니다.'
}

async function handleConnectWebDav() {
  const url = webdavUrl.value.trim()
  if (!url || isWebDavConnecting.value) return

  webdavError.value = ''
  webdavSuccessMsg.value = ''
  isWebDavConnecting.value = true

  const startPath = webdavPath.value.trim() || '/'

  try {
    // Save / update in recent connections list whenever connection info is submitted
    webdavHistory.value = await saveWebDavConnection({
      alias: '',
      url,
      username: webdavUsername.value.trim(),
      password: webdavPassword.value,
      initialPath: startPath
    })

    // Check if the user entered a direct .epub or .txt file URL on WebDAV
    const cleanUrlNoQuery = url.split('?')[0].toLowerCase()
    if (cleanUrlNoQuery.endsWith('.epub') || cleanUrlNoQuery.endsWith('.txt')) {
      const downloaded = await downloadWebDavFile(
        url,
        '',
        webdavUsername.value.trim(),
        webdavPassword.value
      )
      const book = await bookStore.addBookFromBuffer(
        downloaded.buffer,
        `${downloaded.filename}.${downloaded.format}`,
        downloaded.format,
        downloaded.sourceUrl
      )
      emit('downloaded', book)
      emit('close')
      return
    }

    const items = await listWebDavDirectory(
      url,
      startPath,
      webdavUsername.value.trim(),
      webdavPassword.value
    )
    webdavItems.value = items
    currentBrowsePath.value = startPath.startsWith('/') ? startPath : `/${startPath}`
    explorerSearchQuery.value = ''
    // Open the dedicated Full Screen WebDAV Explorer view
    isWebDavExplorerOpen.value = true
  } catch (err: any) {
    webdavError.value =
      err?.message || 'WebDAV 서버에 연결할 수 없습니다. 주소와 계정 정보를 확인해 주세요.'
  } finally {
    isWebDavConnecting.value = false
  }
}

async function selectRecentConnection(conn: WebDavConnection, autoConnect = true) {
  webdavUrl.value = conn.url
  webdavPath.value = conn.initialPath || '/'
  webdavUsername.value = conn.username
  webdavPassword.value = conn.password || ''
  webdavError.value = ''
  webdavSuccessMsg.value = ''

  if (autoConnect) {
    await handleConnectWebDav()
  }
}

async function handleDeleteRecentConnection(id: string) {
  webdavHistory.value = await removeWebDavConnection(id)
}

async function navigateWebDavFolder(targetPath: string) {
  if (isWebDavConnecting.value) return
  webdavError.value = ''
  isWebDavConnecting.value = true
  try {
    const items = await listWebDavDirectory(
      webdavUrl.value.trim(),
      targetPath,
      webdavUsername.value.trim(),
      webdavPassword.value
    )
    webdavItems.value = items
    currentBrowsePath.value = targetPath
    explorerSearchQuery.value = ''
  } catch (err: any) {
    webdavError.value = err?.message || '폴더 목록을 불러오지 못했습니다.'
  } finally {
    isWebDavConnecting.value = false
  }
}

async function navigateUpFolder() {
  const segments = currentBrowsePath.value.split('/').filter(Boolean)
  if (segments.length === 0) return
  segments.pop()
  const parentPath = segments.length > 0 ? `/${segments.join('/')}` : '/'
  await navigateWebDavFolder(parentPath)
}

async function handleDownloadWebDavItem(item: WebDavItem, openImmediately = false) {
  if (item.isDirectory) {
    await navigateWebDavFolder(item.path)
    return
  }
  if (downloadingItemPath.value) return

  webdavError.value = ''
  downloadingItemPath.value = item.path
  try {
    const downloaded = await downloadWebDavFile(
      webdavUrl.value.trim(),
      item.path,
      webdavUsername.value.trim(),
      webdavPassword.value
    )
    const fileName = item.name.toLowerCase().endsWith(`.${downloaded.format}`)
      ? item.name
      : `${item.name}.${downloaded.format}`
    const book = await bookStore.addBookFromBuffer(
      downloaded.buffer,
      fileName,
      downloaded.format,
      downloaded.sourceUrl
    )
    downloadedPaths.value.add(item.path)
    emit('downloaded', book)

    if (openImmediately) {
      emit('close')
      router.push({ name: 'reader', params: { id: book.id } })
    } else {
      showExplorerToast(`'${book.title}' 문서를 오프라인 서재에 저장했습니다.`)
    }
  } catch (err: any) {
    webdavError.value = err?.message || `'${item.name}' 파일 다운로드에 실패했습니다.`
  } finally {
    downloadingItemPath.value = ''
  }
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function formatItemDate(rawDate?: string): string {
  if (!rawDate) return ''
  const parsed = new Date(rawDate)
  if (Number.isNaN(parsed.getTime())) return rawDate
  const yyyy = parsed.getFullYear()
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  const dd = String(parsed.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 w-full h-full flex flex-col overflow-hidden"
    :style="{
      backgroundColor: 'var(--ev-bg)',
      color: 'var(--ev-text)',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      paddingLeft: 'env(safe-area-inset-left, 0px)',
      paddingRight: 'env(safe-area-inset-right, 0px)'
    }"
  >
    <!-- ========================================================================= -->
    <!-- SCREEN 2: FULL-SCREEN WEBDAV DIRECTORY EXPLORER (Opened after connecting) -->
    <!-- ========================================================================= -->
    <template v-if="activeTab === 'webdav' && isWebDavExplorerOpen">
      <!-- Explorer Top Header -->
      <header
        class="px-4 sm:px-8 py-4 border-b flex flex-wrap items-center justify-between gap-3 shrink-0"
        :style="{
          backgroundColor: 'var(--ev-surface)',
          borderColor: 'var(--ev-border)'
        }"
      >
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            class="p-2 rounded-xl border flex items-center justify-center hover:border-indigo-500 transition-colors shrink-0"
            :style="{ borderColor: 'var(--ev-border)' }"
            title="WebDAV 연결 설정으로 돌아가기"
            @click="isWebDavExplorerOpen = false"
          >
            <ArrowLeft class="w-4 h-4" />
          </button>

          <div class="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
            <Server class="w-5 h-5" />
          </div>

          <div class="min-w-0">
            <h1 class="text-lg font-extrabold tracking-tight flex items-center gap-2 truncate">
              <span class="truncate">{{ activeServerLabel }}</span>
              <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                연결됨
              </span>
            </h1>
          </div>
        </div>
      </header>

      <!-- Explorer Path, Sort Filter & Search Sub-header -->
      <div
        class="px-4 sm:px-8 py-3 border-b flex flex-wrap items-center justify-between gap-3 shrink-0"
        :style="{
          backgroundColor: 'var(--ev-surface)',
          borderColor: 'var(--ev-border)'
        }"
      >
        <div class="flex items-center gap-2 min-w-0">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-colors"
            :style="{ borderColor: 'var(--ev-border)' }"
            title="현재 폴더 새로고침"
            @click="navigateWebDavFolder(currentBrowsePath)"
          >
            <RefreshCw class="w-4 h-4 text-indigo-500" :class="{ 'animate-spin': isWebDavConnecting }" />
            <span class="hidden sm:inline">새로고침</span>
          </button>
          
          <button
            v-if="currentBrowsePath !== '/'"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold hover:border-indigo-500 shrink-0 transition-colors"
            :style="{ borderColor: 'var(--ev-border)' }"
            @click="navigateUpFolder"
          >
            <CornerLeftUp class="w-3.5 h-3.5 text-indigo-500" />
            <span>상위 폴더</span>
          </button>

          <span class="px-2.5 py-1 rounded-lg bg-indigo-600 text-white text-xs font-bold break-all">
            {{ currentFolderName }}
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-end">
          <span class="text-xs opacity-65 shrink-0">
            폴더 <strong>{{ folderCount }}</strong> · 문서 <strong>{{ fileCount }}</strong>
          </span>

          <!-- Sort Filter Buttons (이름 / 날짜 / 용량 + 오름차순·내림차순) -->
          <div class="flex items-center gap-1 p-1 rounded-xl bg-black/5 dark:bg-white/5 shrink-0">
            <button
              v-for="opt in ([
                { key: 'name', label: '이름' },
                { key: 'date', label: '날짜' },
                { key: 'size', label: '용량' }
              ] as const)"
              :key="opt.key"
              type="button"
              class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
              :class="
                explorerSortKey === opt.key
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'opacity-70 hover:opacity-100'
              "
              :title="`${opt.label} 기준 정렬 (${explorerSortKey === opt.key && explorerSortOrder === 'asc' ? '오름차순' : '내림차순'})`"
              @click="toggleExplorerSort(opt.key)"
            >
              <span>{{ opt.label }}</span>
              <template v-if="explorerSortKey === opt.key">
                <ArrowUp v-if="explorerSortOrder === 'asc'" class="w-3 h-3" />
                <ArrowDown v-else class="w-3 h-3" />
              </template>
              <ArrowUpDown v-else class="w-3 h-3 opacity-40" />
            </button>
          </div>

          <div class="relative w-full sm:w-56">
            <Search class="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
            <input
              v-model="explorerSearchQuery"
              type="text"
              placeholder="현재 폴더 내 이름 검색..."
              class="w-full pl-8 pr-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
              :style="{ borderColor: 'var(--ev-border)' }"
            />
          </div>
        </div>
      </div>

      <!-- Error Banner inside Explorer -->
      <div
        v-if="webdavError"
        class="mx-4 sm:mx-8 mt-4 flex items-start gap-2 p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs shrink-0"
      >
        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
        <span>{{ webdavError }}</span>
      </div>

      <!-- Full-Screen Directory & File List -->
      <main class="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
        <div class="w-full">
          <!-- Loading Indicator -->
          <div
            v-if="isWebDavConnecting"
            class="h-72 flex flex-col items-center justify-center gap-3 opacity-75"
          >
            <Loader2 class="w-8 h-8 animate-spin text-indigo-500" />
            <p class="text-sm font-semibold">폴더 목록을 불러오고 있습니다...</p>
          </div>

          <!-- Empty Directory State -->
          <div
            v-else-if="filteredWebdavItems.length === 0"
            class="h-72 rounded-3xl border-2 border-dashed flex flex-col items-center justify-center text-center p-6"
            :style="{ borderColor: 'var(--ev-border)' }"
          >
            <Folder class="w-12 h-12 mb-3 opacity-30" />
            <p class="text-sm font-bold mb-1">표시할 폴더나 문서(.txt, .epub)가 없습니다</p>
            <p class="text-xs opacity-60 mb-4">
              다른 하위 폴더로 이동하거나 상위 폴더 버튼을 눌러 탐색해 보세요.
            </p>
            <button
              v-if="currentBrowsePath !== '/'"
              type="button"
              class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold"
              @click="navigateUpFolder"
            >
              <CornerLeftUp class="w-4 h-4" />
              <span>상위 폴더로 이동</span>
            </button>
          </div>

          <!-- Items Table / Card List -->
          <div
            v-else
            class="rounded-2xl border overflow-hidden divide-y shadow-xs"
            :style="{
              backgroundColor: 'var(--ev-surface)',
              borderColor: 'var(--ev-border)'
            }"
          >
            <button
              v-for="item in filteredWebdavItems"
              :key="item.path"
              type="button"
              :disabled="downloadingItemPath === item.path"
              class="w-full px-4 sm:px-6 py-3.5 flex items-start sm:items-center gap-3.5 text-left hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
              @click="handleDownloadWebDavItem(item, false)"
            >
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                :class="
                  item.isDirectory
                    ? 'bg-amber-500/15 text-amber-500'
                    : item.format === 'epub'
                      ? 'bg-indigo-500/15 text-indigo-500'
                      : 'bg-emerald-500/15 text-emerald-500'
                "
              >
                <Loader2
                  v-if="downloadingItemPath === item.path"
                  class="w-5 h-5 animate-spin text-indigo-500"
                />
                <Folder v-else-if="item.isDirectory" class="w-5 h-5" />
                <BookOpen v-else-if="item.format === 'epub'" class="w-5 h-5" />
                <FileText v-else class="w-5 h-5" />
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-sm font-bold break-all whitespace-normal leading-snug">
                    {{ item.name }}
                  </p>
                  <span
                    v-if="downloadedPaths.has(item.path)"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0"
                  >
                    <CheckCircle2 class="w-3 h-3" />
                    저장됨
                  </span>
                </div>
                <p
                  v-if="(!item.isDirectory && item.size) || item.lastModified"
                  class="text-xs opacity-60 mt-1 font-mono flex flex-wrap items-center gap-1.5"
                >
                  <span v-if="!item.isDirectory && item.size">{{ formatSize(item.size) }}</span>
                  <span v-if="!item.isDirectory && item.size && item.lastModified">·</span>
                  <span v-if="item.lastModified">{{ formatItemDate(item.lastModified) }}</span>
                </p>
              </div>
            </button>
          </div>
        </div>
      </main>

      <!-- Explorer Toast -->
      <div
        v-if="explorerToast"
        class="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-medium shadow-xl flex items-center gap-2"
      >
        <CheckCircle2 class="w-4 h-4 text-emerald-400" />
        <span>{{ explorerToast }}</span>
      </div>
    </template>

    <!-- ========================================================================= -->
    <!-- SCREEN 1: FULL-SCREEN DOWNLOAD & WEBDAV CONNECTION SETUP                  -->
    <!-- ========================================================================= -->
    <template v-else>
      <!-- Full-Screen Header -->
      <header
        class="px-4 sm:px-8 py-4 border-b flex flex-wrap items-center justify-between gap-3 shrink-0"
        :style="{
          backgroundColor: 'var(--ev-surface)',
          borderColor: 'var(--ev-border)'
        }"
      >
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            class="p-2 rounded-xl border flex items-center justify-center hover:border-indigo-500 transition-colors shrink-0"
            :style="{ borderColor: 'var(--ev-border)' }"
            title="서재로 돌아가기"
            @click="emit('close')"
          >
            <ArrowLeft class="w-4 h-4" />
          </button>

          <div class="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
            <Download class="w-5 h-5" />
          </div>

          <div>
            <h1 class="text-lg font-extrabold tracking-tight">원격 문서 다운로드</h1>
          </div>
        </div>

        <!-- Mode Switcher Tabs in Header -->
        <div class="flex items-center gap-1 p-1 rounded-xl bg-black/5 dark:bg-white/5">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
            :class="
              activeTab === 'url'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'opacity-70 hover:opacity-100'
            "
            @click="activeTab = 'url'"
          >
            <Globe class="w-4 h-4" />
            <span>URL 다운로드</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
            :class="
              activeTab === 'webdav'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'opacity-70 hover:opacity-100'
            "
            @click="activeTab = 'webdav'"
          >
            <Server class="w-4 h-4" />
            <span>WebDAV 연결</span>
            <span
              v-if="webdavHistory.length > 0"
              class="px-1.5 py-0.2 rounded-full text-[10px] font-mono"
              :class="activeTab === 'webdav' ? 'bg-white/20 text-white' : 'bg-indigo-500/15 text-indigo-500'"
            >
              {{ webdavHistory.length }}
            </span>
          </button>
        </div>
      </header>

      <!-- Full-Screen Main Content -->
      <main class="flex-1 overflow-y-auto px-3 sm:px-4 py-3">
        <!-- TAB 1: URL 다운로드 (Full Screen Layout) -->
        <div v-if="activeTab === 'url'" class="w-full">
          <div
            class="rounded-2xl border p-4 shadow-xs"
            :style="{
              backgroundColor: 'var(--ev-surface)',
              borderColor: 'var(--ev-border)'
            }"
          >
            <div class="flex items-center gap-2 mb-3">
              <Globe class="w-4 h-4 text-indigo-500" />
              <h2 class="text-sm font-bold">원격 문서 URL 직접 다운로드</h2>
            </div>

            <form class="space-y-4" @submit.prevent="handleUrlDownload">
              <div>
                <label class="block text-xs font-semibold mb-1.5 opacity-80">
                  원격 문서 URL (.txt 또는 .epub)
                </label>
                <input
                  v-model="remoteUrl"
                  type="url"
                  required
                  placeholder="https://example.com/books/novel.epub"
                  class="w-full px-3.5 py-2 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  :style="{ borderColor: 'var(--ev-border)' }"
                />
                <p class="mt-1.5 text-xs opacity-65">
                  다운로드된 문서는 기기 내부 로컬 스토리지에 영구 캐싱되어 오프라인에서도 즉시 읽을 수 있습니다.
                </p>
              </div>

              <!-- Progress bar -->
              <div v-if="isDownloading" class="space-y-1.5">
                <div class="flex items-center justify-between text-xs font-medium">
                  <span class="flex items-center gap-1.5 text-indigo-500">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    오프라인 저장소로 다운로드 중...
                  </span>
                  <span class="font-mono">{{ progressPercent }}%</span>
                </div>
                <div class="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    class="h-full bg-indigo-600 transition-all duration-200"
                    :style="{ width: `${progressPercent}%` }"
                  />
                </div>
              </div>

              <!-- Error Alert -->
              <div
                v-if="errorMessage"
                class="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs"
              >
                <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
                <span>{{ errorMessage }}</span>
              </div>

              <div class="flex items-center justify-end gap-2 pt-3 border-t" :style="{ borderColor: 'var(--ev-border)' }">
                <button
                  type="submit"
                  :disabled="isDownloading || !remoteUrl.trim()"
                  class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs transition-colors"
                >
                  <Download v-if="!isDownloading" class="w-3.5 h-3.5" />
                  <CheckCircle2 v-else class="w-3.5 h-3.5" />
                  <span>다운로드</span>
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- TAB 2: WebDAV 연결 설정 및 최근 접속내역 (Compact Full-Width Layout) -->
        <div v-else class="w-full grid grid-cols-1 lg:grid-cols-12 gap-3">
          <!-- Left Column: Compact WebDAV Connection Form -->
          <div class="lg:col-span-5">
            <div
              class="rounded-2xl border p-3.5 sm:p-4 shadow-xs"
              :style="{
                backgroundColor: 'var(--ev-surface)',
                borderColor: 'var(--ev-border)'
              }"
            >
              <div class="flex items-center gap-2 mb-3">
                <Server class="w-4 h-4 text-indigo-500" />
                <h2 class="text-sm font-bold">WebDAV 서버 연결 정보 입력</h2>
              </div>

              <form class="space-y-2.5" @submit.prevent="handleConnectWebDav">
                <div>
                  <label class="block text-[11px] font-semibold mb-1 opacity-80">WebDAV 서버 URL *</label>
                  <input
                    v-model="webdavUrl"
                    type="url"
                    required
                    placeholder="https://example.synology.me:5006/Comic"
                    class="w-full px-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    :style="{ borderColor: 'var(--ev-border)' }"
                  />
                </div>

                <div class="grid grid-cols-3 gap-2">
                  <div>
                    <label class="block text-[11px] font-semibold mb-1 opacity-80">초기 경로</label>
                    <input
                      v-model="webdavPath"
                      type="text"
                      placeholder="/"
                      class="w-full px-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      :style="{ borderColor: 'var(--ev-border)' }"
                    />
                  </div>

                  <div>
                    <label class="block text-[11px] font-semibold mb-1 opacity-80">아이디</label>
                    <input
                      v-model="webdavUsername"
                      type="text"
                      autocomplete="username"
                      placeholder="아이디"
                      class="w-full px-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      :style="{ borderColor: 'var(--ev-border)' }"
                    />
                  </div>

                  <div>
                    <label class="block text-[11px] font-semibold mb-1 opacity-80">비밀번호</label>
                    <input
                      v-model="webdavPassword"
                      type="password"
                      autocomplete="current-password"
                      placeholder="비밀번호"
                      class="w-full px-3 py-1.5 rounded-xl border text-xs bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      :style="{ borderColor: 'var(--ev-border)' }"
                    />
                  </div>
                </div>

                <!-- Alerts -->
                <div
                  v-if="webdavError"
                  class="flex items-start gap-2 p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs"
                >
                  <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{{ webdavError }}</span>
                </div>

                <div
                  v-if="webdavSuccessMsg"
                  class="flex items-center gap-2 p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs"
                >
                  <CheckCircle2 class="w-4 h-4 shrink-0" />
                  <span>{{ webdavSuccessMsg }}</span>
                </div>

                <div class="flex flex-wrap items-center justify-end gap-2 pt-2.5 border-t" :style="{ borderColor: 'var(--ev-border)' }">
                  <button
                    type="submit"
                    :disabled="isWebDavConnecting || !webdavUrl.trim()"
                    class="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs transition-colors"
                  >
                    <Loader2 v-if="isWebDavConnecting" class="w-3.5 h-3.5 animate-spin" />
                    <Server v-else class="w-3.5 h-3.5" />
                    <span>WebDAV 연결하기</span>
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- Right Column: Recent WebDAV Connections History -->
          <div class="lg:col-span-7">
            <div
              class="rounded-2xl border p-3.5 sm:p-4 shadow-xs h-full flex flex-col"
              :style="{
                backgroundColor: 'var(--ev-surface)',
                borderColor: 'var(--ev-border)'
              }"
            >
              <div class="flex items-center justify-between mb-2.5">
                <div class="flex items-center gap-2">
                  <Clock class="w-4 h-4 text-indigo-500" />
                  <h2 class="text-sm font-bold">최근 WebDAV 접속내역 ({{ webdavHistory.length }})</h2>
                </div>
              </div>

              <div
                v-if="webdavHistory.length === 0"
                class="flex-1 min-h-40 rounded-xl border border-dashed flex flex-col items-center justify-center p-4 text-center text-xs opacity-60"
                :style="{ borderColor: 'var(--ev-border)' }"
              >
                <Server class="w-7 h-7 mb-1.5 opacity-40" />
                <p>저장된 최근 WebDAV 접속내역이 없습니다.</p>
                <p class="mt-0.5">서버 정보를 입력해 연결하면 이곳에 자동으로 목록이 관리됩니다.</p>
              </div>

              <div v-else class="space-y-2 overflow-y-auto max-h-[75vh] pr-1">
                <div
                  v-for="conn in webdavHistory"
                  :key="conn.id"
                  class="group rounded-xl border p-2.5 sm:p-3 flex items-center justify-between gap-2.5 hover:border-indigo-500/60 transition-all cursor-pointer"
                  :style="{ borderColor: 'var(--ev-border)' }"
                  @click="selectRecentConnection(conn, false)"
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2 mb-0.5">
                      <span class="text-xs font-bold break-all font-mono">{{ conn.url }}</span>
                      <span
                        v-if="conn.username"
                        class="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 shrink-0"
                      >
                        {{ conn.username }}
                      </span>
                    </div>
                    <p class="text-[10px] opacity-55">
                      경로: {{ conn.initialPath || '/' }} · {{ formatDate(conn.lastConnectedAt) }}
                    </p>
                  </div>

                  <div class="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      :disabled="isWebDavConnecting"
                      class="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold transition-colors"
                      @click.stop="selectRecentConnection(conn, true)"
                    >
                      접속
                    </button>
                    <button
                      type="button"
                      class="p-1.5 rounded-lg opacity-60 hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                      title="최근 접속내역에서 삭제"
                      @click.stop="handleDeleteRecentConnection(conn.id)"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </template>
  </div>
</template>
