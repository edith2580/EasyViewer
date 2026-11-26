import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookStore } from '@/stores/useBookStore'
import { platformStorage } from '@/services/storage/platformAdapter'

describe('useBookStore characterization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('adds TXT book buffer, deduplicates bookmarks, clamps location, and removes book', async () => {
    const store = useBookStore()
    const sampleBuf = new TextEncoder().encode('제1장 별\n본문 내용입니다.').buffer

    const added = await store.addBookFromBuffer(sampleBuf, '별 헤는 밤 - 윤동주.txt', 'txt')
    expect(added.format).toBe('txt')
    expect(added.title).toBe('별 헤는 밤')
    expect(added.author).toBe('윤동주')
    expect(added.fileSize).toBe(sampleBuf.byteLength)

    await store.saveReadingLocation(added.id, 'offset:12', 142.4, '제1장 별')
    expect(store.positions[added.id].percentage).toBe(100)

    const bm1 = await store.addBookmark(added.id, 'offset:12', 42.34, '첫 책갈피', '본문 내용')
    const bmDup = await store.addBookmark(added.id, 'offset:12', 42.34, '중복', '중복')
    expect(bmDup.id).toBe(bm1.id)
    expect(store.getBookBookmarks(added.id)).toHaveLength(1)

    await store.removeBookmark(added.id, bm1.id)
    expect(store.getBookBookmarks(added.id)).toHaveLength(0)

    const deleted = await store.removeBook(added.id)
    expect(deleted).toBe(true)
    expect(store.books.find((b) => b.id === added.id)).toBeUndefined()
  })

  it('keeps a different book with a colliding id separate instead of overwriting the first one', async () => {
    const store = useBookStore()
    // Same name, same size and identical first 4 KB => same short id; contents differ after that.
    const head = 'ㄱ'.repeat(3000)
    const first = new TextEncoder().encode(`${head}첫 번째 책의 끝`).buffer
    const second = new TextEncoder().encode(`${head}두 번째 책의 끝`).buffer
    expect(first.byteLength).toBe(second.byteLength)

    const a = await store.addBookFromBuffer(first, '같은 이름.txt', 'txt')
    const b = await store.addBookFromBuffer(second, '같은 이름.txt', 'txt')
    expect(b.id).not.toBe(a.id)
    expect(b.id.startsWith(a.id)).toBe(true)
    expect(store.books.filter((book) => book.fileName === '같은 이름.txt')).toHaveLength(2)
    expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/)

    // Re-importing the identical file still maps onto the existing entry.
    const again = await store.addBookFromBuffer(first, '같은 이름.txt', 'txt')
    expect(again.id).toBe(a.id)
    expect(store.books.filter((book) => book.fileName === '같은 이름.txt')).toHaveLength(2)
  })

  it('initializes library from stored metadata without losing bookmarks or positions', async () => {
    await platformStorage.setItem('library_books_v1', [
      {
        id: 'book-1',
        title: '기존 도서',
        author: '작가',
        format: 'txt',
        fileSize: 120,
        addedAt: 1000,
        lastOpenedAt: 2000
      }
    ])
    await platformStorage.setItem('samples_seeded_v1', true)
    await platformStorage.setItem('reading_positions_v1', {
      'book-1': {
        bookId: 'book-1',
        locator: 'offset:20',
        percentage: 15,
        updatedAt: 2000,
        deviceId: 'd-test'
      }
    })

    const store = useBookStore()
    await store.initLibrary()

    expect(store.isInitialized).toBe(true)
    expect(store.books).toHaveLength(1)
    expect(store.books[0].lastLocation?.locator).toBe('offset:20')
  })
})
