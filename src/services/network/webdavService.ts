import type { BookFormat, WebDavConnection, WebDavItem } from '@/types'
import { isTauriEnv, platformStorage } from '@/services/storage/platformAdapter'
import {
  extractFilenameFromUrl,
  inferBookFormat,
  type DownloadedFileResult,
  type DownloadProgress
} from '@/services/network/downloadService'

const WEBDAV_HISTORY_KEY = 'webdav_history'

function encodeBasicAuth(username: string, password?: string): string {
  if (!username && !password) return ''
  const raw = `${username}:${password || ''}`
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `Basic ${btoa(binary)}`
}

async function universalFetch(
  url: string,
  options: {
    method: string
    headers?: Record<string, string>
    body?: string
  }
): Promise<Response> {
  if (isTauriEnv()) {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      return await tauriFetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body
      })
    } catch {
      // Fallback to local proxy below if Tauri HTTP plugin rejects custom port or self-signed cert
    }
  }

  // Use same-origin Vite proxy (/ __remote_proxy) to bypass browser CORS preflight & self-signed NAS cert issues
  try {
    const proxyHeaders: Record<string, string> = {
      'x-target-url': url,
      'x-target-method': options.method
    }
    if (options.headers?.Authorization) {
      proxyHeaders['x-target-auth'] = options.headers.Authorization
    }
    if (options.headers?.Depth) {
      proxyHeaders['x-target-depth'] = options.headers.Depth
    }
    if (options.headers?.['Content-Type']) {
      proxyHeaders['Content-Type'] = options.headers['Content-Type']
    }

    const proxyRes = await fetch('/__remote_proxy', {
      method: options.body ? 'POST' : 'GET',
      headers: proxyHeaders,
      body: options.body
    })

    if (proxyRes.status !== 404) {
      if (proxyRes.status === 502) {
        const errText = await proxyRes.text()
        throw new Error(errText || '원격 WebDAV 서버에 연결할 수 없습니다.')
      }
      return proxyRes
    }
  } catch (err: any) {
    if (err?.message?.includes('원격')) {
      throw err
    }
  }

  return await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body
  })
}

export function buildWebDavTargetUrl(
  serverUrl: string,
  subPath: string,
  isDirectory = false
): string {
  const base = serverUrl.trim().replace(/\/+$/, '')
  const cleanSub = subPath.trim().replace(/^\/+|\/+$/g, '')

  let fullUrl = base
  if (cleanSub) {
    const encodedSegments = cleanSub
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
      .join('/')

    // Avoid duplicating path if serverUrl already ends with the same path segment
    const lowerBase = base.toLowerCase()
    const lowerSub = `/${encodedSegments.toLowerCase()}`
    const lowerRawSub = `/${cleanSub.toLowerCase()}`
    if (!lowerBase.endsWith(lowerSub) && !lowerBase.endsWith(lowerRawSub)) {
      fullUrl = `${base}/${encodedSegments}`
    }
  }

  if (isDirectory && !fullUrl.endsWith('/')) {
    return `${fullUrl}/`
  }
  return fullUrl
}

/**
 * Loads saved WebDAV connection profiles sorted by most recently connected
 */
export async function loadWebDavHistory(): Promise<WebDavConnection[]> {
  const list = await platformStorage.getItem<WebDavConnection[]>(WEBDAV_HISTORY_KEY, [])
  return list.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
}

/**
 * Adds or updates a WebDAV connection profile in the recent connections list
 */
export async function saveWebDavConnection(
  input: Omit<WebDavConnection, 'id' | 'lastConnectedAt'> & { id?: string }
): Promise<WebDavConnection[]> {
  const history = await loadWebDavHistory()
  const cleanUrl = input.url.trim().replace(/\/+$/, '')
  const cleanUser = input.username.trim()
  const cleanPath = input.initialPath?.trim() || '/'

  let defaultAlias = input.alias?.trim()
  if (!defaultAlias) {
    try {
      const parsed = new URL(cleanUrl)
      defaultAlias = cleanUser ? `${cleanUser}@${parsed.host}` : parsed.host
    } catch {
      defaultAlias = cleanUrl
    }
  }

  const existingIdx = history.findIndex(
    (item) =>
      (input.id && item.id === input.id) ||
      (item.url.replace(/\/+$/, '') === cleanUrl && item.username === cleanUser)
  )

  const record: WebDavConnection = {
    id: existingIdx >= 0 ? history[existingIdx].id : input.id || `webdav-${Date.now()}`,
    alias: defaultAlias,
    url: cleanUrl,
    username: cleanUser,
    password: input.password ?? (existingIdx >= 0 ? history[existingIdx].password : ''),
    initialPath: cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`,
    lastConnectedAt: Date.now()
  }

  if (existingIdx >= 0) {
    history.splice(existingIdx, 1)
  }
  history.unshift(record)

  const trimmed = history.slice(0, 20)
  await platformStorage.setItem(WEBDAV_HISTORY_KEY, trimmed)
  return trimmed
}

/**
 * Removes a WebDAV connection profile from recent history
 */
export async function removeWebDavConnection(id: string): Promise<WebDavConnection[]> {
  const history = await loadWebDavHistory()
  const filtered = history.filter((item) => item.id !== id)
  await platformStorage.setItem(WEBDAV_HISTORY_KEY, filtered)
  return filtered
}

/**
 * Lists folders and supported documents (.txt, .epub) from a WebDAV server directory via PROPFIND
 */
export async function listWebDavDirectory(
  serverUrl: string,
  subPath: string,
  username = '',
  password = ''
): Promise<WebDavItem[]> {
  const targetUrl = buildWebDavTargetUrl(serverUrl, subPath, true)
  const headers: Record<string, string> = {
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8'
  }
  const auth = encodeBasicAuth(username, password)
  if (auth) {
    headers.Authorization = auth
  }

  const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`

  const response = await universalFetch(targetUrl, {
    method: 'PROPFIND',
    headers,
    body: propfindBody
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error(`WebDAV 인증 실패 (HTTP ${response.status}): 아이디 또는 비밀번호를 확인해 주세요.`)
  }
  if (!response.ok && response.status !== 207) {
    throw new Error(`WebDAV 서버 응답 오류 (HTTP ${response.status})`)
  }

  const xmlText = await response.text()
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')

  const baseParsed = new URL(serverUrl.trim())
  const basePathPrefix = decodeURIComponent(baseParsed.pathname).replace(/\/+$/, '')
  const targetParsed = new URL(targetUrl)
  const currentFullDecodedPath =
    '/' + decodeURIComponent(targetParsed.pathname).replace(/^\/+|\/+$/g, '')

  const responses = Array.from(doc.getElementsByTagNameNS('*', 'response'))
  const items: WebDavItem[] = []

  for (const respNode of responses) {
    const hrefNode = respNode.getElementsByTagNameNS('*', 'href')[0]
    if (!hrefNode || !hrefNode.textContent) continue

    const rawHref = hrefNode.textContent.trim()
    let decodedPathname = rawHref
    try {
      if (rawHref.startsWith('http://') || rawHref.startsWith('https://')) {
        decodedPathname = decodeURIComponent(new URL(rawHref).pathname)
      } else {
        decodedPathname = decodeURIComponent(rawHref)
      }
    } catch {
      // Keep rawHref if decoding fails
    }

    const normalizedItemFull = '/' + decodedPathname.replace(/^\/+|\/+$/g, '')

    // Skip the current directory entry itself
    if (normalizedItemFull.toLowerCase() === currentFullDecodedPath.toLowerCase()) {
      continue
    }

    let relativePath = decodedPathname
    if (
      basePathPrefix &&
      relativePath.toLowerCase().startsWith(basePathPrefix.toLowerCase())
    ) {
      relativePath = relativePath.slice(basePathPrefix.length)
    }
    const cleanRel = '/' + relativePath.replace(/^\/+|\/+$/g, '')

    const resourceTypeNode = respNode.getElementsByTagNameNS('*', 'resourcetype')[0]
    const isDirectory = Boolean(
      resourceTypeNode && resourceTypeNode.getElementsByTagNameNS('*', 'collection').length > 0
    )

    const displayNameNode = respNode.getElementsByTagNameNS('*', 'displayname')[0]
    const segments = cleanRel.split('/').filter(Boolean)
    const fallbackName = segments[segments.length - 1] || cleanRel
    const name = displayNameNode?.textContent?.trim() || fallbackName

    const lengthNode = respNode.getElementsByTagNameNS('*', 'getcontentlength')[0]
    const size = lengthNode?.textContent ? parseInt(lengthNode.textContent.trim(), 10) || 0 : 0

    const modifiedNode = respNode.getElementsByTagNameNS('*', 'getlastmodified')[0]
    const lastModified = modifiedNode?.textContent?.trim()

    const lowerName = name.toLowerCase()
    let format: BookFormat | undefined
    if (!isDirectory) {
      if (lowerName.endsWith('.epub')) format = 'epub'
      else if (lowerName.endsWith('.txt')) format = 'txt'
      else continue // Only show directories and supported book files (.epub, .txt)
    }

    items.push({
      name,
      path: cleanRel,
      href: rawHref,
      isDirectory,
      size,
      lastModified,
      format
    })
  }

  return items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'ko')
  })
}

/**
 * Downloads a book file (.txt or .epub) from a WebDAV server with optional Basic Auth
 */
export async function downloadWebDavFile(
  serverUrl: string,
  filePath: string,
  username = '',
  password = '',
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadedFileResult> {
  const targetUrl = buildWebDavTargetUrl(serverUrl, filePath, false)
  const headers: Record<string, string> = {}
  const auth = encodeBasicAuth(username, password)
  if (auth) {
    headers.Authorization = auth
  }

  const response = await universalFetch(targetUrl, {
    method: 'GET',
    headers
  })

  if (!response.ok) {
    throw new Error(`WebDAV 파일 다운로드 실패 (HTTP ${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  const contentLengthHeader = response.headers.get('content-length')
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0

  const buffer = await response.arrayBuffer()
  onProgress?.({
    loaded: buffer.byteLength,
    total: totalBytes || buffer.byteLength,
    percent: 100
  })

  const format = inferBookFormat(targetUrl, contentType, buffer)
  const filename = extractFilenameFromUrl(targetUrl, format)

  return {
    buffer,
    filename,
    format,
    sourceUrl: targetUrl
  }
}
