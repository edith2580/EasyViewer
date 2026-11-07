import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BookFormat, BookMeta, BookmarkItem, ReadingLocation, SyncPayload } from '@/types'
import { platformStorage } from '@/services/storage/platformAdapter'
import { extractEpubMetadata } from '@/engines/epub/epubEngine'
import { createSampleEpubBook, createSampleTxtBook } from '@/services/sampleBooks'
import { downloadRemoteBook, type DownloadProgress } from '@/services/network/downloadService'
import { getOrCreateDeviceId, synchronizeReadingData } from '@/services/sync/syncService'
import { useSettingsStore } from './useSettingsStore'

const BOOKS_META_KEY = 'library_books_v1'
const POSITIONS_KEY = 'reading_positions_v1'
const BOOKMARKS_KEY = 'bookmarks_v1'
const SAMPLES_SEEDED_KEY = 'samples_seeded_v1'

/**
 * Generates a deterministic fingerprint ID from file name and byte size / head bytes
 */
async function computeBookHash(name: string, buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer)
  const sampleSize = Math.min(bytes.length, 4096)
  let hash = 2166136261
  for (let i = 0; i < sampleSize; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619)
  }
  const cleanName = name.replace(/\.(epub|txt)$/i, '').trim().toLowerCase()
  for (let i = 0; i < cleanName.length; i++) {
    hash ^= cleanName.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `book-${(hash >>> 0).toString(16)}-${buffer.byteLength}`
}

export const useBookStore = defineStore('books', () => {
  const books = ref<BookMeta[]>([])
  const positions = ref<Record<string, ReadingLocation>>({})
  const bookmarks = ref<Record<string, BookmarkItem[]>>({})
  const isInitialized = ref(false)
  const isSyncing = ref(false)
  const lastSyncTime = ref<number | null>(null)
  const syncStatusMessage = ref<string>('')

  const sortedBooks = computed(() =>
    [...books.value].sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
  )

  async function initLibrary() {
    if (isInitialized.value) return
    books.value = await platformStorage.getItem<BookMeta[]>(BOOKS_META_KEY, [])
    positions.value = await platformStorage.getItem<Record<string, ReadingLocation>>(POSITIONS_KEY, {})
    bookmarks.value = await platformStorage.getItem<Record<string, BookmarkItem[]>>(BOOKMARKS_KEY, {})

    const seeded = await platformStorage.getItem<boolean>(SAMPLES_SEEDED_KEY, false)
    if (!seeded && books.value.length === 0) {
      await seedSampleBooks()
      await platformStorage.setItem(SAMPLES_SEEDED_KEY, true)
    }

    // Attach latest reading locations to book metadata
    for (const book of books.value) {
      if (positions.value[book.id]) {
        book.lastLocation = positions.value[book.id]
      }
    }

    isInitialized.value = true
  }

  async function persistAll() {
    await platformStorage.setItem(BOOKS_META_KEY, books.value)
    await platformStorage.setItem(POSITIONS_KEY, positions.value)
    await platformStorage.setItem(BOOKMARKS_KEY, bookmarks.value)
  }

  async function seedSampleBooks() {
    const epubBuffer = await createSampleEpubBook()
    await addBookFromBuffer(epubBuffer, 'EasyViewer 완벽 가이드 및 샘플 북.epub', 'epub')

    const txtBuffer = createSampleTxtBook()
    await addBookFromBuffer(txtBuffer, '메밀꽃 필 무렵 - 이효석.txt', 'txt')
  }

  async function addBookFromBuffer(
    buffer: ArrayBuffer,
    filename: string,
    explicitFormat?: BookFormat,
    sourceUrl?: string
  ): Promise<BookMeta> {
    const lower = filename.toLowerCase()
    const format: BookFormat =
      explicitFormat || (lower.endsWith('.epub') ? 'epub' : 'txt')

    const id = await computeBookHash(filename, buffer)
    await platformStorage.saveBookBinary(id, buffer)

    let title = filename.replace(/\.(epub|txt)$/i, '')
    let author = format === 'epub' ? 'EPUB 문서' : 'TXT 문서'
    let coverUrl: string | undefined

    if (format === 'epub') {
      const epubMeta = await extractEpubMetadata(buffer)
      if (epubMeta.title && epubMeta.title !== '제목 없는 EPUB') {
        title = epubMeta.title
      }
      if (epubMeta.author) {
        author = epubMeta.author
      }
      coverUrl = epubMeta.coverUrl
    } else if (title.includes(' - ')) {
      const parts = title.split(' - ')
      title = parts[0].trim()
      author = parts.slice(1).join(' - ').trim()
    }

    const now = Date.now()
    const existingIdx = books.value.findIndex((b) => b.id === id)
    const meta: BookMeta = {
      id,
      title,
      author,
      format,
      fileSize: buffer.byteLength,
      coverUrl,
      sourceUrl,
      isOfflineCached: true,
      addedAt: existingIdx >= 0 ? books.value[existingIdx].addedAt : now,
      lastOpenedAt: now,
      lastLocation: positions.value[id]
    }

    if (existingIdx >= 0) {
      books.value[existingIdx] = meta
    } else {
      books.value.unshift(meta)
    }

    await persistAll()
    return meta
  }

  async function importFromUrl(
    url: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<BookMeta> {
    const result = await downloadRemoteBook(url, onProgress)
    return await addBookFromBuffer(
      result.buffer,
      `${result.filename}.${result.format}`,
      result.format,
      result.sourceUrl
    )
  }

  async function removeBook(bookId: string) {
    books.value = books.value.filter((b) => b.id !== bookId)
    await platformStorage.removeBookBinary(bookId)
    await persistAll()
  }

  async function saveReadingLocation(
    bookId: string,
    locator: string,
    percentage: number,
    chapterTitle?: string
  ) {
    const deviceId = await getOrCreateDeviceId()
    const now = Date.now()
    const location: ReadingLocation = {
      bookId,
      locator,
      percentage: Math.min(100, Math.max(0, Math.round(percentage * 10) / 10)),
      chapterTitle,
      updatedAt: now,
      deviceId
    }
    positions.value[bookId] = location

    const target = books.value.find((b) => b.id === bookId)
    if (target) {
      target.lastLocation = location
      target.lastOpenedAt = now
    }

    await platformStorage.setItem(POSITIONS_KEY, positions.value)
    await platformStorage.setItem(BOOKS_META_KEY, books.value)
  }

  function getBookBookmarks(bookId: string): BookmarkItem[] {
    return bookmarks.value[bookId] || []
  }

  async function addBookmark(
    bookId: string,
    locator: string,
    percentage: number,
    title: string,
    excerpt: string
  ): Promise<BookmarkItem> {
    const list = bookmarks.value[bookId] ? [...bookmarks.value[bookId]] : []
    const existing = list.find((b) => b.locator === locator)
    if (existing) return existing

    const item: BookmarkItem = {
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bookId,
      locator,
      percentage: Math.round(percentage * 10) / 10,
      title: title || '책갈피',
      excerpt: excerpt.slice(0, 120),
      createdAt: Date.now()
    }
    list.unshift(item)
    bookmarks.value[bookId] = list
    await platformStorage.setItem(BOOKMARKS_KEY, bookmarks.value)
    return item
  }

  async function removeBookmark(bookId: string, bookmarkId: string) {
    if (!bookmarks.value[bookId]) return
    bookmarks.value[bookId] = bookmarks.value[bookId].filter((b) => b.id !== bookmarkId)
    await platformStorage.setItem(BOOKMARKS_KEY, bookmarks.value)
  }

  async function syncNow(): Promise<{ updatedCount: number; message: string }> {
    const settingsStore = useSettingsStore()
    isSyncing.value = true
    try {
      const result = await synchronizeReadingData(
        settingsStore.settings.syncEndpoint,
        positions.value,
        bookmarks.value,
        settingsStore.settings
      )
      positions.value = result.payload.positions
      bookmarks.value = result.payload.bookmarks

      for (const book of books.value) {
        if (positions.value[book.id]) {
          book.lastLocation = positions.value[book.id]
        }
      }

      await persistAll()
      lastSyncTime.value = Date.now()
      const msg =
        result.mode === 'remote'
          ? `원격 서버 동기화 완료 (${result.updatedCount}건 갱신)`
          : `로컬 허브 동기화 완료 (${result.updatedCount}건 갱신)`
      syncStatusMessage.value = msg
      return { updatedCount: result.updatedCount, message: msg }
    } finally {
      isSyncing.value = false
    }
  }

  async function exportSyncSnapshot(): Promise<string> {
    const settingsStore = useSettingsStore()
    const deviceId = await getOrCreateDeviceId()
    const payload: SyncPayload = {
      version: 1,
      exportedAt: Date.now(),
      deviceId,
      positions: positions.value,
      bookmarks: bookmarks.value,
      settings: settingsStore.settings
    }
    return JSON.stringify(payload, null, 2)
  }

  async function importSyncSnapshot(jsonText: string): Promise<number> {
    const parsed = JSON.parse(jsonText) as SyncPayload
    if (!parsed || typeof parsed !== 'object' || !parsed.positions) {
      throw new Error('유효하지 않은 동기화 데이터 형식입니다.')
    }
    let updatedCount = 0
    for (const [bookId, remoteLoc] of Object.entries(parsed.positions)) {
      const localLoc = positions.value[bookId]
      if (!localLoc || remoteLoc.updatedAt >= localLoc.updatedAt) {
        positions.value[bookId] = remoteLoc
        updatedCount++
      }
    }
    if (parsed.bookmarks) {
      for (const [bookId, remoteList] of Object.entries(parsed.bookmarks)) {
        const current = bookmarks.value[bookId] || []
        const map = new Map(current.map((b) => [b.locator, b]))
        for (const item of remoteList) {
          map.set(item.locator, item)
        }
        bookmarks.value[bookId] = Array.from(map.values())
      }
    }
    for (const book of books.value) {
      if (positions.value[book.id]) {
        book.lastLocation = positions.value[book.id]
      }
    }
    await persistAll()
    lastSyncTime.value = Date.now()
    return updatedCount
  }

  return {
    books,
    sortedBooks,
    positions,
    bookmarks,
    isInitialized,
    isSyncing,
    lastSyncTime,
    syncStatusMessage,
    initLibrary,
    seedSampleBooks,
    addBookFromBuffer,
    importFromUrl,
    removeBook,
    saveReadingLocation,
    getBookBookmarks,
    addBookmark,
    removeBookmark,
    syncNow,
    exportSyncSnapshot,
    importSyncSnapshot
  }
})

