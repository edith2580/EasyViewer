<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBookStore } from '@/stores/useBookStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { platformStorage } from '@/services/storage/platformAdapter'
import { EpubViewerEngine } from '@/engines/epub/epubEngine'
import {
  detectAndDecodeText,
  paginateTxtDocument,
  parseOffsetLocator,
  parseTxtDocument,
  searchTxtDocument,
  type TxtPage,
  type TxtParagraph
} from '@/engines/txt/txtEngine'
import type { BookmarkItem, SearchResultItem, TocItem } from '@/types'
import ViewerSettingsPanel from '@/components/viewer/ViewerSettingsPanel.vue'
import ViewerSideDrawer, { type DrawerTab } from '@/components/viewer/ViewerSideDrawer.vue'
import {
  ArrowLeft,
  ListTree,
  Bookmark,
  BookmarkCheck,
  Search,
  Settings,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Loader2
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const bookStore = useBookStore()
const settingsStore = useSettingsStore()

const bookId = computed(() => String(route.params.id || ''))
const currentBook = computed(() => bookStore.books.find((b) => b.id === bookId.value))
const bookBookmarks = computed(() => bookStore.getBookBookmarks(bookId.value))

const isLoading = ref(true)
const loadError = ref('')
const toastMsg = ref('')

// Drawer & Settings UI states
const drawerOpen = ref(false)
const drawerTab = ref<DrawerTab>('toc')
const settingsOpen = ref(false)

// Document state
const tocItems = ref<TocItem[]>([])
const currentLocator = ref<string>('')
const currentPercentage = ref<number>(0)
const currentChapterTitle = ref<string>('본문')

// Search state
const isSearching = ref(false)
const searchResults = ref<SearchResultItem[]>([])
const highlightedKeyword = ref('')
const highlightedParaIndex = ref<number | null>(null)

// EPUB Engine
const epubContainerRef = ref<HTMLElement | null>(null)
let epubEngine: EpubViewerEngine | null = null

// TXT Engine state
const txtEncoding = ref('UTF-8')
const txtParagraphs = ref<TxtParagraph[]>([])
const txtTotalLength = ref(1)
const txtScrollContainerRef = ref<HTMLElement | null>(null)
const txtPaginatedViewportRef = ref<HTMLElement | null>(null)
const txtPages = ref<TxtPage[]>([])
const txtCurrentPageIdx = ref(0)
const viewportSize = ref({ width: 900, height: 680 })

const isCurrentPositionBookmarked = computed(() =>
  bookBookmarks.value.some((b) => b.locator === currentLocator.value)
)

const fontFamilyCss = computed(() => {
  const map: Record<string, string> = {
    sans: '"Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif',
    serif: '"Nanum Myeongjo", "Noto Serif KR", Georgia, serif',
    mono: '"D2Coding", Consolas, monospace',
    system: 'system-ui, -apple-system, sans-serif'
  }
  return map[settingsStore.settings.fontFamily] || map.sans
})

function showToast(msg: string) {
  toastMsg.value = msg
  setTimeout(() => {
    if (toastMsg.value === msg) toastMsg.value = ''
  }, 2600)
}

async function loadDocument() {
  isLoading.value = true
  loadError.value = ''

  await settingsStore.initSettings()
  await bookStore.initLibrary()

  const book = currentBook.value
  if (!book) {
    loadError.value = '요청한 문서를 서재에서 찾을 수 없습니다.'
    isLoading.value = false
    return
  }

  const buffer = await platformStorage.loadBookBinary(book.id)
  if (!buffer) {
    loadError.value = '문서 원본 데이터가 로컬 캐시에 존재하지 않습니다.'
    isLoading.value = false
    return
  }

  const savedLoc = bookStore.positions[book.id]
  const initialLocator = savedLoc?.locator || ''
  const initialPercentage = savedLoc?.percentage ?? 0
  currentLocator.value = initialLocator
  currentPercentage.value = initialPercentage
  currentChapterTitle.value = savedLoc?.chapterTitle || '본문'

  if (book.format === 'epub') {
    isLoading.value = false
    await nextTick()
    if (!epubContainerRef.value) return
    epubEngine = new EpubViewerEngine()
    try {
      const info = await epubEngine.loadBook(
        buffer,
        epubContainerRef.value,
        settingsStore.settings,
        initialLocator,
        (loc) => {
          currentLocator.value = loc.cfi
          currentPercentage.value = loc.percentage
          currentChapterTitle.value = loc.chapterTitle
          bookStore.saveReadingLocation(book.id, loc.cfi, loc.percentage, loc.chapterTitle)
        },
        initialPercentage
      )
      tocItems.value = info.toc
    } catch (err: any) {
      loadError.value = err?.message || 'EPUB 파일을 렌더링하는 중 오류가 발생했습니다.'
    }
  } else {
    // TXT Document
    const decoded = detectAndDecodeText(buffer)
    txtEncoding.value = decoded.encoding
    const parsed = parseTxtDocument(decoded.text)
    txtParagraphs.value = parsed.paragraphs
    tocItems.value = parsed.toc
    txtTotalLength.value = parsed.totalLength
    isLoading.value = false

    await nextTick()
    updateViewportMeasurements()
    recalculateTxtPages(parseOffsetLocator(initialLocator))

    if (settingsStore.settings.viewMode === 'scroll') {
      await scrollToTxtOffset(parseOffsetLocator(initialLocator))
    }
  }
}

function updateViewportMeasurements() {
  const el = txtPaginatedViewportRef.value || txtScrollContainerRef.value
  if (el) {
    viewportSize.value = {
      width: el.clientWidth || 880,
      height: el.clientHeight || 660
    }
  }
}

function recalculateTxtPages(targetCharOffset = 0) {
  if (currentBook.value?.format !== 'txt') return
  txtPages.value = paginateTxtDocument(txtParagraphs.value, txtTotalLength.value, {
    containerWidth: viewportSize.value.width,
    containerHeight: viewportSize.value.height,
    fontSize: settingsStore.settings.fontSize,
    lineHeight: settingsStore.settings.lineHeight,
    pageMargin: settingsStore.settings.pageMargin
  })

  // Find page containing targetCharOffset
  const foundIdx = txtPages.value.findIndex(
    (p) => targetCharOffset >= p.startOffset && targetCharOffset <= p.endOffset
  )
  txtCurrentPageIdx.value = foundIdx >= 0 ? foundIdx : 0
  syncTxtPaginatedLocation()
}

function syncTxtPaginatedLocation() {
  if (currentBook.value?.format !== 'txt' || settingsStore.settings.viewMode !== 'paginated') return
  const page = txtPages.value[txtCurrentPageIdx.value]
  if (!page) return

  const locator = `offset:${page.startOffset}`
  const heading = findTxtChapterForOffset(page.startOffset)
  currentLocator.value = locator
  currentPercentage.value = page.percentage
  currentChapterTitle.value = heading
  bookStore.saveReadingLocation(bookId.value, locator, page.percentage, heading)
}

function findTxtChapterForOffset(offset: number): string {
  let active = '본문'
  for (const item of tocItems.value) {
    const itemOffset = parseOffsetLocator(item.href)
    if (itemOffset <= offset) {
      active = item.label
    } else {
      break
    }
  }
  return active
}

async function scrollToTxtOffset(offset: number) {
  await nextTick()
  const container = txtScrollContainerRef.value
  if (!container) return
  const ratio = Math.max(0, Math.min(1, offset / txtTotalLength.value))
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTop = Math.round(maxScroll * ratio)
}

function handleTxtScroll() {
  if (currentBook.value?.format !== 'txt' || settingsStore.settings.viewMode !== 'scroll') return
  const container = txtScrollContainerRef.value
  if (!container) return
  const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight)
  const ratio = Math.max(0, Math.min(1, container.scrollTop / maxScroll))
  const approxOffset = Math.round(ratio * txtTotalLength.value)
  const pct = Math.round(ratio * 1000) / 10
  const locator = `offset:${approxOffset}`
  const heading = findTxtChapterForOffset(approxOffset)

  currentLocator.value = locator
  currentPercentage.value = pct
  currentChapterTitle.value = heading
  bookStore.saveReadingLocation(bookId.value, locator, pct, heading)
}

async function prevPage() {
  if (currentBook.value?.format === 'epub') {
    await epubEngine?.prev()
    return
  }

  if (settingsStore.settings.viewMode === 'paginated') {
    if (txtCurrentPageIdx.value > 0) {
      txtCurrentPageIdx.value--
      syncTxtPaginatedLocation()
    }
  } else if (txtScrollContainerRef.value) {
    txtScrollContainerRef.value.scrollBy({
      top: -txtScrollContainerRef.value.clientHeight * 0.85,
      behavior: 'smooth'
    })
  }
}

async function nextPage() {
  if (currentBook.value?.format === 'epub') {
    await epubEngine?.next()
    return
  }

  if (settingsStore.settings.viewMode === 'paginated') {
    if (txtCurrentPageIdx.value < txtPages.value.length - 1) {
      txtCurrentPageIdx.value++
      syncTxtPaginatedLocation()
    }
  } else if (txtScrollContainerRef.value) {
    txtScrollContainerRef.value.scrollBy({
      top: txtScrollContainerRef.value.clientHeight * 0.85,
      behavior: 'smooth'
    })
  }
}

async function handleProgressSliderChange(e: Event) {
  const pct = Number((e.target as HTMLInputElement).value)
  currentPercentage.value = pct

  if (currentBook.value?.format === 'epub') {
    await epubEngine?.goToPercentage(pct)
  } else {
    const targetOffset = Math.round((pct / 100) * txtTotalLength.value)
    if (settingsStore.settings.viewMode === 'paginated') {
      const idx = Math.min(
        txtPages.value.length - 1,
        Math.max(0, Math.floor((pct / 100) * txtPages.value.length))
      )
      txtCurrentPageIdx.value = idx
      syncTxtPaginatedLocation()
    } else {
      await scrollToTxtOffset(targetOffset)
    }
  }
}

function openDrawerTab(tab: DrawerTab) {
  drawerTab.value = tab
  drawerOpen.value = true
}

async function handleSelectToc(item: TocItem) {
  drawerOpen.value = false
  if (currentBook.value?.format === 'epub') {
    await epubEngine?.goTo(item.href)
  } else {
    const offset = parseOffsetLocator(item.href)
    if (settingsStore.settings.viewMode === 'paginated') {
      recalculateTxtPages(offset)
    } else {
      await scrollToTxtOffset(offset)
    }
  }
}

async function handleToggleBookmark() {
  if (!currentBook.value) return
  const existing = bookBookmarks.value.find((b) => b.locator === currentLocator.value)
  if (existing) {
    await bookStore.removeBookmark(currentBook.value.id, existing.id)
    showToast('현재 위치의 책갈피를 해제했습니다.')
    return
  }
  await handleAddBookmark()
}

async function handleAddBookmark() {
  if (!currentBook.value) return
  let excerpt = `${currentChapterTitle.value} (${currentPercentage.value.toFixed(1)}%)`
  if (currentBook.value.format === 'txt') {
    const offset = parseOffsetLocator(currentLocator.value)
    const para = txtParagraphs.value.find(
      (p) => p.startOffset >= offset && p.text.trim().length > 0
    )
    if (para) {
      excerpt = para.text.trim().slice(0, 100)
    }
  }

  await bookStore.addBookmark(
    currentBook.value.id,
    currentLocator.value || 'offset:0',
    currentPercentage.value,
    currentChapterTitle.value || currentBook.value.title,
    excerpt
  )
  showToast('현재 위치를 책갈피에 저장했습니다.')
}

async function handleSelectBookmark(bm: BookmarkItem) {
  drawerOpen.value = false
  if (currentBook.value?.format === 'epub') {
    await epubEngine?.goTo(bm.locator)
  } else {
    const offset = parseOffsetLocator(bm.locator)
    if (settingsStore.settings.viewMode === 'paginated') {
      recalculateTxtPages(offset)
    } else {
      await scrollToTxtOffset(offset)
    }
  }
}

async function handleUnifiedSearch(query: string) {
  const q = query.trim()
  if (!q || !currentBook.value) return
  isSearching.value = true
  highlightedKeyword.value = q

  try {
    if (currentBook.value.format === 'epub') {
      searchResults.value = (await epubEngine?.search(q)) || []
    } else {
      searchResults.value = searchTxtDocument(txtParagraphs.value, txtTotalLength.value, q)
    }
  } finally {
    isSearching.value = false
  }
}

async function handleSelectSearchResult(hit: SearchResultItem, query: string) {
  drawerOpen.value = false
  highlightedKeyword.value = query

  if (currentBook.value?.format === 'epub') {
    await epubEngine?.goTo(hit.locator)
    epubEngine?.highlightSearchCfi(hit.locator)
  } else {
    const offset = parseOffsetLocator(hit.locator)
    highlightedParaIndex.value = hit.matchIndex ?? null
    if (settingsStore.settings.viewMode === 'paginated') {
      recalculateTxtPages(offset)
    } else {
      await nextTick()
      const paraEl = document.getElementById(`txt-para-${hit.matchIndex}`)
      if (paraEl) {
        paraEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        await scrollToTxtOffset(offset)
      }
    }
  }
}

async function handleQuickSync() {
  const res = await bookStore.syncNow()
  const syncedLoc = bookStore.positions[bookId.value]
  if (syncedLoc && syncedLoc.locator !== currentLocator.value) {
    if (currentBook.value?.format === 'epub') {
      await epubEngine?.goTo(syncedLoc.locator)
    } else {
      const offset = parseOffsetLocator(syncedLoc.locator)
      if (settingsStore.settings.viewMode === 'paginated') {
        recalculateTxtPages(offset)
      } else {
        await scrollToTxtOffset(offset)
      }
    }
  }
  showToast(res.message)
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openDrawerTab('search')
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    handleToggleBookmark()
    return
  }
  if (e.key === 'Escape') {
    drawerOpen.value = false
    settingsOpen.value = false
    return
  }
  if (drawerOpen.value || settingsOpen.value) return

  if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault()
    nextPage()
  }
}

function handleResize() {
  updateViewportMeasurements()
  if (currentBook.value?.format === 'txt' && settingsStore.settings.viewMode === 'paginated') {
    recalculateTxtPages(parseOffsetLocator(currentLocator.value))
  }
}

// React to viewer settings changes in real time
watch(
  () => settingsStore.settings,
  async (newSettings) => {
    if (currentBook.value?.format === 'epub') {
      epubEngine?.applySettings(newSettings)
    } else if (currentBook.value?.format === 'txt') {
      const offset = parseOffsetLocator(currentLocator.value)
      await nextTick()
      updateViewportMeasurements()
      if (newSettings.viewMode === 'paginated') {
        recalculateTxtPages(offset)
      } else {
        await scrollToTxtOffset(offset)
      }
    }
  },
  { deep: true }
)

onMounted(() => {
  loadDocument()
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', handleResize)
  epubEngine?.destroy()
})
</script>

<template>
  <div
    class="h-screen flex flex-col overflow-hidden"
    :style="{
      backgroundColor: 'var(--ev-reader-bg)',
      color: 'var(--ev-text)'
    }"
  >
    <!-- Top Reader Navigation Bar -->
    <header
      class="h-14 px-3 sm:px-6 border-b flex items-center justify-between gap-2 shrink-0 z-20"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)'
      }"
    >
      <div class="flex items-center gap-2 min-w-0">
        <button
          type="button"
          class="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="서재로 돌아가기"
          @click="router.push({ name: 'library' })"
        >
          <ArrowLeft class="w-5 h-5" />
        </button>

        <div class="min-w-0">
          <h1 class="text-sm font-bold truncate">{{ currentBook?.title || '문서 뷰어' }}</h1>
          <p class="text-[11px] opacity-60 truncate">
            {{ currentChapterTitle }} · {{ currentPercentage.toFixed(1) }}%
          </p>
        </div>
      </div>

      <!-- Reader Toolbar Actions -->
      <div class="flex items-center gap-1 sm:gap-1.5 shrink-0">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="목차 및 챕터 이동"
          @click="openDrawerTab('toc')"
        >
          <ListTree class="w-4 h-4 text-indigo-500" />
          <span class="hidden md:inline">목차</span>
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="통합 본문 검색 (Ctrl+F)"
          @click="openDrawerTab('search')"
        >
          <Search class="w-4 h-4 text-indigo-500" />
          <span class="hidden md:inline">검색</span>
        </button>

        <button
          type="button"
          class="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          :title="isCurrentPositionBookmarked ? '책갈피 해제 (Ctrl+B)' : '현재 위치 책갈피 추가 (Ctrl+B)'"
          @click="handleToggleBookmark"
        >
          <BookmarkCheck
            v-if="isCurrentPositionBookmarked"
            class="w-4 h-4 text-amber-500 fill-amber-500"
          />
          <Bookmark v-else class="w-4 h-4" />
        </button>

        <button
          type="button"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="책갈피 목록 보기"
          @click="openDrawerTab('bookmarks')"
        >
          <span class="text-xs font-mono px-1.5 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500">
            {{ bookBookmarks.length }}
          </span>
        </button>

        <button
          type="button"
          class="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="마지막 읽은 위치 동기화"
          @click="handleQuickSync"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': bookStore.isSyncing }" />
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition-colors"
          title="글꼴·테마·보기 방식 옵션"
          @click="settingsOpen = true"
        >
          <Settings class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">옵션</span>
        </button>
      </div>
    </header>

    <!-- Main Document Canvas -->
    <div class="relative flex-1 overflow-hidden flex flex-col">
      <!-- Loading Overlay -->
      <div
        v-if="isLoading"
        class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3"
        :style="{ backgroundColor: 'var(--ev-reader-bg)' }"
      >
        <Loader2 class="w-8 h-8 animate-spin text-indigo-500" />
        <p class="text-sm font-medium opacity-75">문서를 불러오고 있습니다...</p>
      </div>

      <!-- Error State -->
      <div
        v-else-if="loadError"
        class="flex-1 flex flex-col items-center justify-center p-6 text-center"
      >
        <p class="text-sm font-bold text-red-500 mb-3">{{ loadError }}</p>
        <button
          type="button"
          class="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold"
          @click="router.push({ name: 'library' })"
        >
          서재로 돌아가기
        </button>
      </div>

      <!-- 1. EPUB Viewer Canvas -->
      <template v-else-if="currentBook?.format === 'epub'">
        <div class="relative flex-1 w-full h-full overflow-hidden">
          <div ref="epubContainerRef" class="w-full h-full" />

          <!-- Left / Right Page Flip Buttons in Paginated Mode -->
          <template v-if="settingsStore.settings.viewMode === 'paginated'">
            <button
              type="button"
              class="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full border shadow-md opacity-40 hover:opacity-100 transition-opacity"
              :style="{
                backgroundColor: 'var(--ev-surface)',
                borderColor: 'var(--ev-border)'
              }"
              title="이전 페이지 (←)"
              @click="prevPage"
            >
              <ChevronLeft class="w-5 h-5" />
            </button>

            <button
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full border shadow-md opacity-40 hover:opacity-100 transition-opacity"
              :style="{
                backgroundColor: 'var(--ev-surface)',
                borderColor: 'var(--ev-border)'
              }"
              title="다음 페이지 (→)"
              @click="nextPage"
            >
              <ChevronRight class="w-5 h-5" />
            </button>
          </template>
        </div>
      </template>

      <!-- 2. TXT Viewer Canvas -->
      <template v-else-if="currentBook?.format === 'txt'">
        <!-- 2-A. TXT Vertical Scroll Mode -->
        <div
          v-if="settingsStore.settings.viewMode === 'scroll'"
          ref="txtScrollContainerRef"
          class="flex-1 overflow-y-auto"
          @scroll.passive="handleTxtScroll"
        >
          <article
            class="max-w-4xl mx-auto py-8 transition-all"
            :style="{
              fontFamily: fontFamilyCss,
              fontSize: `${settingsStore.settings.fontSize}px`,
              lineHeight: settingsStore.settings.lineHeight,
              paddingLeft: `${settingsStore.settings.pageMargin}px`,
              paddingRight: `${settingsStore.settings.pageMargin}px`
            }"
          >
            <p
              v-for="para in txtParagraphs"
              :id="`txt-para-${para.index}`"
              :key="para.index"
              class="mb-3 break-words rounded-lg transition-colors"
              :class="[
                para.isHeading ? 'font-bold text-[1.2em] mt-6 mb-3 text-indigo-600 dark:text-indigo-400' : '',
                highlightedParaIndex === para.index ? 'bg-amber-400/25 px-2 py-1 ring-1 ring-amber-400' : ''
              ]"
            >
              {{ para.text || '\u00A0' }}
            </p>
          </article>
        </div>

        <!-- 2-B. TXT Horizontal Paginated Mode -->
        <div
          v-else
          ref="txtPaginatedViewportRef"
          class="relative flex-1 flex flex-col justify-between overflow-hidden select-text"
        >
          <div
            class="flex-1 max-w-4xl w-full mx-auto py-6 overflow-hidden"
            :style="{
              fontFamily: fontFamilyCss,
              fontSize: `${settingsStore.settings.fontSize}px`,
              lineHeight: settingsStore.settings.lineHeight,
              paddingLeft: `${settingsStore.settings.pageMargin}px`,
              paddingRight: `${settingsStore.settings.pageMargin}px`
            }"
          >
            <template v-if="txtPages[txtCurrentPageIdx]">
              <p
                v-for="para in txtPages[txtCurrentPageIdx].paragraphs"
                :key="para.index"
                class="mb-2.5 break-words rounded-md"
                :class="[
                  para.isHeading ? 'font-bold text-[1.15em] mt-2 mb-2 text-indigo-600 dark:text-indigo-400' : '',
                  highlightedParaIndex === para.index ? 'bg-amber-400/25 px-2 py-0.5' : ''
                ]"
              >
                {{ para.text || '\u00A0' }}
              </p>
            </template>
          </div>

          <!-- Left / Right Floating Page Flip Buttons -->
          <button
            type="button"
            :disabled="txtCurrentPageIdx <= 0"
            class="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full border shadow-md opacity-50 hover:opacity-100 disabled:opacity-15 transition-opacity"
            :style="{
              backgroundColor: 'var(--ev-surface)',
              borderColor: 'var(--ev-border)'
            }"
            title="이전 페이지 (←)"
            @click="prevPage"
          >
            <ChevronLeft class="w-5 h-5" />
          </button>

          <button
            type="button"
            :disabled="txtCurrentPageIdx >= txtPages.length - 1"
            class="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full border shadow-md opacity-50 hover:opacity-100 disabled:opacity-15 transition-opacity"
            :style="{
              backgroundColor: 'var(--ev-surface)',
              borderColor: 'var(--ev-border)'
            }"
            title="다음 페이지 (→)"
            @click="nextPage"
          >
            <ChevronRight class="w-5 h-5" />
          </button>
        </div>
      </template>
    </div>

    <!-- Bottom Progress Bar -->
    <footer
      class="h-12 px-4 sm:px-6 border-t flex items-center justify-between gap-4 text-xs shrink-0 z-20"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)'
      }"
    >
      <div class="flex items-center gap-2 shrink-0">
        <span class="font-semibold uppercase px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10">
          {{ settingsStore.settings.viewMode === 'paginated' ? '가로 페이지' : '세로 스크롤' }}
        </span>
        <span
          v-if="currentBook?.format === 'txt'"
          class="hidden sm:inline font-mono text-[11px] opacity-65"
        >
          {{ txtEncoding }}
        </span>
      </div>

      <!-- Progress Slider -->
      <div class="flex-1 max-w-xl flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          step="0.5"
          :value="currentPercentage"
          class="w-full accent-indigo-600 cursor-pointer"
          @change="handleProgressSliderChange"
        />
      </div>

      <div class="flex items-center gap-2 font-mono shrink-0">
        <span
          v-if="currentBook?.format === 'txt' && settingsStore.settings.viewMode === 'paginated'"
          class="opacity-70"
        >
          {{ txtCurrentPageIdx + 1 }} / {{ txtPages.length }}p ·
        </span>
        <span class="font-bold text-indigo-600 dark:text-indigo-400">
          {{ currentPercentage.toFixed(1) }}%
        </span>
      </div>
    </footer>

    <!-- Side Drawer (TOC / Bookmarks / Unified Search) -->
    <ViewerSideDrawer
      :open="drawerOpen"
      :active-tab="drawerTab"
      :toc="tocItems"
      :bookmarks="bookBookmarks"
      :search-results="searchResults"
      :is-searching="isSearching"
      :current-chapter="currentChapterTitle"
      @close="drawerOpen = false"
      @update:active-tab="drawerTab = $event"
      @select-toc="handleSelectToc"
      @select-bookmark="handleSelectBookmark"
      @add-bookmark="handleAddBookmark"
      @remove-bookmark="(bmId) => currentBook && bookStore.removeBookmark(currentBook.id, bmId)"
      @search="handleUnifiedSearch"
      @select-search="handleSelectSearchResult"
    />

    <!-- Viewer Settings Modal -->
    <ViewerSettingsPanel
      :open="settingsOpen"
      @close="settingsOpen = false"
    />

    <!-- Toast Notification -->
    <div
      v-if="toastMsg"
      class="fixed bottom-16 right-5 z-50 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-medium shadow-xl"
    >
      {{ toastMsg }}
    </div>
  </div>
</template>

