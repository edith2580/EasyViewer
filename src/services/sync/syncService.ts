import type { BookmarkItem, ReadingLocation, SyncPayload, ViewerSettings } from '@/types'
import { platformStorage } from '@/services/storage/platformAdapter'
import { remoteFetch, RemoteFetchConsentError } from '@/services/network/remoteFetch'

const SYNC_CACHE_KEY = 'cloud_sync_snapshot'
/** Credential-store id of the optional sync server access token (never part of the payload). */
export const SYNC_TOKEN_CREDENTIAL_ID = 'sync-endpoint-token'
const DEVICE_ID_KEY = 'device_id'

/** Non-transient 4xx HTTP rejection from the remote sync endpoint that must surface to the caller. */
class SyncHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`SYNC_HTTP_ERROR (${status}): 원격 동기화 서버가 요청을 거부했습니다.`)
    this.name = 'SyncHttpError'
    this.status = status
  }
}

function isFatalSyncError(err: unknown): boolean {
  return (
    err instanceof SyncHttpError ||
    (err instanceof RemoteFetchConsentError &&
      (err.code === 'BLOCKED_HIGH_RISK' ||
        err.code === 'PRIVATE_NETWORK_CONFIRM_REQUIRED' ||
        err.code === 'SELF_SIGNED_TLS_CONFIRM_REQUIRED'))
  )
}

function checkSyncResponseOk(res: Response): boolean {
  if (res.ok) return true
  if (res.status >= 400 && res.status < 500) {
    throw new SyncHttpError(res.status)
  }
  return false
}

const MAX_SYNC_BOOKS = 10_000
const MAX_BOOKMARKS_PER_BOOK = 2_000
const MAX_LOCATOR_LENGTH = 4_096
const MAX_TEXT_LENGTH = 1_000
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isSafeKey(key: string): boolean {
  return key.length > 0 && key.length <= 256 && !UNSAFE_KEYS.has(key)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function clampPercentage(value: unknown): number {
  return Math.min(100, Math.max(0, finiteNumber(value) ?? 0))
}

/**
 * Keeps only well-formed reading positions from data received from a sync server or a pasted
 * snapshot: string locators of bounded length, finite timestamps, no prototype keys
 * (`__proto__`, …), and a bounded number of books. Anything else is dropped.
 */
export function sanitizeReadingPositions(raw: unknown): Record<string, ReadingLocation> {
  const out: Record<string, ReadingLocation> = {}
  const record = asRecord(raw)
  if (!record) return out
  let count = 0
  for (const [bookId, value] of Object.entries(record)) {
    if (count >= MAX_SYNC_BOOKS) break
    const loc = asRecord(value)
    if (!isSafeKey(bookId) || !loc) continue
    const updatedAt = finiteNumber(loc.updatedAt)
    if (typeof loc.locator !== 'string' || loc.locator.length > MAX_LOCATOR_LENGTH || updatedAt === undefined) {
      continue
    }
    const chapterTitle = boundedString(loc.chapterTitle, MAX_TEXT_LENGTH)
    out[bookId] = {
      bookId,
      locator: loc.locator,
      percentage: clampPercentage(loc.percentage),
      ...(chapterTitle !== undefined ? { chapterTitle } : {}),
      updatedAt,
      deviceId: boundedString(loc.deviceId, 128) ?? 'unknown'
    }
    count++
  }
  return out
}

/** Same as {@link sanitizeReadingPositions} for bookmark lists. */
export function sanitizeBookmarks(raw: unknown): Record<string, BookmarkItem[]> {
  const out: Record<string, BookmarkItem[]> = {}
  const record = asRecord(raw)
  if (!record) return out
  let count = 0
  for (const [bookId, value] of Object.entries(record)) {
    if (count >= MAX_SYNC_BOOKS) break
    if (!isSafeKey(bookId) || !Array.isArray(value)) continue
    const items: BookmarkItem[] = []
    for (const entry of value.slice(0, MAX_BOOKMARKS_PER_BOOK)) {
      const item = asRecord(entry)
      if (!item) continue
      const createdAt = finiteNumber(item.createdAt)
      if (typeof item.locator !== 'string' || item.locator.length > MAX_LOCATOR_LENGTH || createdAt === undefined) {
        continue
      }
      items.push({
        id: boundedString(item.id, 128) || `bm-${createdAt}`,
        bookId,
        locator: item.locator,
        percentage: clampPercentage(item.percentage),
        title: boundedString(item.title, MAX_TEXT_LENGTH) || '책갈피',
        excerpt: boundedString(item.excerpt, MAX_TEXT_LENGTH) ?? '',
        createdAt
      })
    }
    out[bookId] = items
    count++
  }
  return out
}

export async function getOrCreateDeviceId(): Promise<string> {
  let id = await platformStorage.getItem<string>(DEVICE_ID_KEY, '')
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`
    await platformStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/**
 * Merges local and remote reading locations using latest timestamp (updatedAt) conflict resolution
 */
export function mergeReadingPositions(
  local: Record<string, ReadingLocation>,
  remote: Record<string, ReadingLocation>
): {
  merged: Record<string, ReadingLocation>
  updatedCount: number
} {
  const merged: Record<string, ReadingLocation> = { ...local }
  let updatedCount = 0

  for (const [bookId, remoteLoc] of Object.entries(remote || {})) {
    if (!isSafeKey(bookId)) continue
    const localLoc = merged[bookId]
    if (!localLoc || remoteLoc.updatedAt > localLoc.updatedAt) {
      merged[bookId] = remoteLoc
      updatedCount++
    }
  }

  return { merged, updatedCount }
}

/**
 * Merges local and remote bookmarks by unique ID & locator deduplication
 */
export function mergeBookmarks(
  local: Record<string, BookmarkItem[]>,
  remote: Record<string, BookmarkItem[]>
): Record<string, BookmarkItem[]> {
  const merged: Record<string, BookmarkItem[]> = { ...local }

  for (const [bookId, remoteList] of Object.entries(remote || {})) {
    if (!isSafeKey(bookId)) continue
    const existing = merged[bookId] || []
    const byLocator = new Map<string, BookmarkItem>()
    for (const item of existing) {
      byLocator.set(item.locator, item)
    }
    for (const item of remoteList || []) {
      if (!byLocator.has(item.locator)) {
        byLocator.set(item.locator, item)
      }
    }
    merged[bookId] = Array.from(byLocator.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  return merged
}

/**
 * Synchronizes reading progress and bookmarks with either a configured remote endpoint
 * or the cross-tab / local sync hub snapshot.
 */
export async function synchronizeReadingData(
  endpoint: string,
  localPositions: Record<string, ReadingLocation>,
  localBookmarks: Record<string, BookmarkItem[]>,
  settings: ViewerSettings,
  /** Optional access token for the sync server, sent as `Authorization: Bearer …`. */
  authToken?: string
): Promise<{
  payload: SyncPayload
  updatedCount: number
  mode: 'remote' | 'local-hub'
}> {
  const deviceId = await getOrCreateDeviceId()
  let remotePayload: SyncPayload | null = null
  let mode: 'remote' | 'local-hub' = 'local-hub'

  const cleanEndpoint = endpoint.trim()
  const token = authToken?.trim()
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (cleanEndpoint && (cleanEndpoint.startsWith('http://') || cleanEndpoint.startsWith('https://'))) {
    try {
      const getRes = await remoteFetch(cleanEndpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
        // Reading positions and bookmark excerpts never go over plain HTTP to the internet.
        forbidPlaintextPublic: true
      })
      if (checkSyncResponseOk(getRes)) {
        remotePayload = (await getRes.json()) as SyncPayload
      }
    } catch (err) {
      if (isFatalSyncError(err)) throw err
      // Fallback to local sync hub only on transient offline or 5xx server errors
    }
  }

  if (!remotePayload) {
    remotePayload = await platformStorage.getItem<SyncPayload | null>(SYNC_CACHE_KEY, null)
  }

  const { merged: mergedPositions, updatedCount } = mergeReadingPositions(
    localPositions,
    sanitizeReadingPositions(remotePayload?.positions)
  )
  const mergedBookmarks = mergeBookmarks(localBookmarks, sanitizeBookmarks(remotePayload?.bookmarks))

  const nextPayload: SyncPayload = {
    version: 1,
    exportedAt: Date.now(),
    deviceId,
    positions: mergedPositions,
    bookmarks: mergedBookmarks,
    settings
  }

  await platformStorage.setItem(SYNC_CACHE_KEY, nextPayload)

  if (cleanEndpoint && (cleanEndpoint.startsWith('http://') || cleanEndpoint.startsWith('https://'))) {
    try {
      const postRes = await remoteFetch(cleanEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(nextPayload),
        forbidPlaintextPublic: true
      })
      if (checkSyncResponseOk(postRes)) {
        mode = 'remote'
      }
    } catch (err) {
      if (isFatalSyncError(err)) throw err
      // Saved locally in sync hub on transient offline or 5xx server errors
    }
  }

  return {
    payload: nextPayload,
    updatedCount,
    mode
  }
}

