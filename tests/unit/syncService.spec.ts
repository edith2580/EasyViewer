import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookmarkItem, ReadingLocation, ViewerSettings } from '@/types'
import { RemoteFetchConsentError } from '@/services/network/remoteFetch'
import {
  getOrCreateDeviceId,
  mergeBookmarks,
  mergeReadingPositions,
  sanitizeBookmarks,
  sanitizeReadingPositions,
  synchronizeReadingData
} from '@/services/sync/syncService'

describe('syncService characterization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it('generates and persists stable deviceId', async () => {
    const first = await getOrCreateDeviceId()
    const second = await getOrCreateDeviceId()
    expect(first).toMatch(/^dev-/)
    expect(second).toBe(first)
  })

  it('merges reading positions keeping newer updatedAt timestamps', () => {
    const local: Record<string, ReadingLocation> = {
      b1: { bookId: 'b1', locator: 'offset:100', percentage: 10, updatedAt: 1000, deviceId: 'd1' },
      b2: { bookId: 'b2', locator: 'offset:500', percentage: 50, updatedAt: 3000, deviceId: 'd1' }
    }
    const remote: Record<string, ReadingLocation> = {
      b1: { bookId: 'b1', locator: 'offset:250', percentage: 25, updatedAt: 2000, deviceId: 'd2' },
      b2: { bookId: 'b2', locator: 'offset:200', percentage: 20, updatedAt: 2500, deviceId: 'd2' },
      b3: { bookId: 'b3', locator: 'offset:10', percentage: 1, updatedAt: 1500, deviceId: 'd2' }
    }

    const { merged, updatedCount } = mergeReadingPositions(local, remote)
    expect(updatedCount).toBe(2)
    expect(merged.b1.locator).toBe('offset:250')
    expect(merged.b2.locator).toBe('offset:500')
    expect(merged.b3.locator).toBe('offset:10')
  })

  it('deduplicates bookmarks by locator and sorts descending by createdAt', () => {
    const local: Record<string, BookmarkItem[]> = {
      b1: [{ id: '1', bookId: 'b1', locator: 'L1', percentage: 10, title: '첫째', excerpt: 'a', createdAt: 100 }]
    }
    const remote: Record<string, BookmarkItem[]> = {
      b1: [
        { id: '1-dup', bookId: 'b1', locator: 'L1', percentage: 10, title: '중복', excerpt: 'a', createdAt: 500 },
        { id: '2', bookId: 'b1', locator: 'L2', percentage: 30, title: '둘째', excerpt: 'b', createdAt: 300 }
      ]
    }

    const merged = mergeBookmarks(local, remote)
    expect(merged.b1).toHaveLength(2)
    expect(merged.b1.map((b) => b.locator)).toEqual(['L2', 'L1'])
  })

  it('synchronizes via local-hub when endpoint is empty and remote when reachable', async () => {
    const settings: ViewerSettings = {
      viewMode: 'scroll',
      theme: 'light',
      fontFamily: 'sans',
      fontSize: 18,
      lineHeight: 1.75,
      pageMargin: 32,
      autoSync: true,
      syncEndpoint: ''
    }

    const localResult = await synchronizeReadingData('', {}, {}, settings)
    expect(localResult.mode).toBe('local-hub')
    expect(localResult.payload.version).toBe(1)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          exportedAt: 100,
          deviceId: 'remote-dev',
          positions: {
            bookA: { bookId: 'bookA', locator: 'offset:99', percentage: 40, updatedAt: 9999999, deviceId: 'remote-dev' }
          },
          bookmarks: {}
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const remoteResult = await synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings)
    expect(remoteResult.mode).toBe('remote')
    expect(remoteResult.updatedCount).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('propagates RemoteFetchConsentError instead of falling back to local-hub (T062)', async () => {
    const settings: ViewerSettings = {
      viewMode: 'scroll',
      theme: 'light',
      fontFamily: 'sans',
      fontSize: 18,
      lineHeight: 1.75,
      pageMargin: 32,
      autoSync: true,
      syncEndpoint: ''
    }

    await expect(
      synchronizeReadingData('http://127.0.0.1:8080/sync', {}, {}, settings)
    ).rejects.toMatchObject({
      name: RemoteFetchConsentError.name,
      code: 'BLOCKED_HIGH_RISK'
    })

    await expect(
      synchronizeReadingData('http://192.168.1.50:8080/sync', {}, {}, settings)
    ).rejects.toMatchObject({
      name: RemoteFetchConsentError.name,
      code: 'PRIVATE_NETWORK_CONFIRM_REQUIRED'
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'SELF_SIGNED_TLS_CONFIRM_REQUIRED',
          error: '자체 서명 TLS 인증서입니다.'
        }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'X-EasyViewer-Proxy': '1' } }
      )
    )
    await expect(
      synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings)
    ).rejects.toMatchObject({
      name: RemoteFetchConsentError.name,
      code: 'SELF_SIGNED_TLS_CONFIRM_REQUIRED'
    })
  })

  it('falls back to local-hub only on transient network or 5xx offline errors (T062)', async () => {
    const settings: ViewerSettings = {
      viewMode: 'scroll',
      theme: 'light',
      fontFamily: 'sans',
      fontSize: 18,
      lineHeight: 1.75,
      pageMargin: 32,
      autoSync: true,
      syncEndpoint: ''
    }

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const offlineResult = await synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings)
    expect(offlineResult.mode).toBe('local-hub')
  })

  it('checks POST response.ok (falls back to local-hub on 5xx, rejects 4xx) (T071)', async () => {
    const settings: ViewerSettings = {
      viewMode: 'scroll',
      theme: 'light',
      fontFamily: 'sans',
      fontSize: 18,
      lineHeight: 1.75,
      pageMargin: 32,
      autoSync: true,
      syncEndpoint: ''
    }

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: 1,
            exportedAt: 100,
            deviceId: 'remote-dev',
            positions: {},
            bookmarks: {}
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))

    const post500Result = await synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(post500Result.mode).toBe('local-hub')

    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: 1,
            exportedAt: 100,
            deviceId: 'remote-dev',
            positions: {},
            bookmarks: {}
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

    await expect(
      synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings)
    ).rejects.toThrow(/401/)
  })

  it('drops malformed or prototype-polluting entries received from a sync server', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"locator":"x","updatedAt":1},"constructor":{"locator":"x","updatedAt":1},' +
        '"book-ok":{"locator":"epubcfi(/6/2)","percentage":250,"updatedAt":5,"deviceId":"d","chapterTitle":"1장"},' +
        '"book-bad-locator":{"locator":{"$gt":""},"updatedAt":5},' +
        '"book-bad-time":{"locator":"x","updatedAt":"soon"},' +
        `"book-long":{"locator":"${'a'.repeat(5000)}","updatedAt":1}}`
    )
    const positions = sanitizeReadingPositions(hostile)
    expect(Object.keys(positions)).toEqual(['book-ok'])
    expect(positions['book-ok'].percentage).toBe(100)
    expect(({} as Record<string, unknown>).locator).toBeUndefined()
    expect(sanitizeReadingPositions(null)).toEqual({})
    expect(sanitizeReadingPositions([1, 2])).toEqual({})

    const bookmarks = sanitizeBookmarks(
      JSON.parse(
        '{"__proto__":[{"locator":"x","createdAt":1}],"book-ok":[{"id":"b1","locator":"l1","percentage":10,"title":"t","excerpt":"e","createdAt":3},{"locator":5,"createdAt":1},"junk"],"book-not-list":{"locator":"x"}}'
      )
    )
    expect(Object.keys(bookmarks)).toEqual(['book-ok'])
    expect(bookmarks['book-ok']).toHaveLength(1)
    expect(bookmarks['book-ok'][0]).toMatchObject({ id: 'b1', bookId: 'book-ok', locator: 'l1' })
  })

  it('sends the optional access token and asks the native side to refuse plaintext public HTTP', async () => {
    const remote = await import('@/services/network/remoteFetch')
    const calls: Array<{ url: string; options: Record<string, unknown> }> = []
    vi.spyOn(remote, 'remoteFetch').mockImplementation(async (url, options) => {
      calls.push({ url, options: (options ?? {}) as Record<string, unknown> })
      return new Response(JSON.stringify({ version: 1, positions: {}, bookmarks: {} }), { status: 200 })
    })
    const settings = {
      viewMode: 'paged',
      theme: 'light',
      fontFamily: 'sans',
      fontSize: 18,
      lineHeight: 1.7,
      pageMargin: 24,
      autoSync: false,
      syncEndpoint: 'https://sync.example.com/payload'
    } as unknown as ViewerSettings
    await synchronizeReadingData('https://sync.example.com/payload', {}, {}, settings, 'secret-token')
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect((call.options.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
      expect(call.options.forbidPlaintextPublic).toBe(true)
    }
    const posted = JSON.parse(String(calls[1].options.body))
    expect(JSON.stringify(posted)).not.toContain('secret-token')
  })
})
