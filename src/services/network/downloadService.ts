import type { BookFormat } from '@/types'
import { isTauriEnv } from '@/services/storage/platformAdapter'

export interface DownloadProgress {
  loaded: number
  total: number
  percent: number
}

export interface DownloadedFileResult {
  buffer: ArrayBuffer
  filename: string
  format: BookFormat
  sourceUrl: string
}

/**
 * Infers book format ('epub' or 'txt') from URL, Content-Type, or ZIP magic bytes (PK\x03\x04)
 */
export function inferBookFormat(url: string, contentType: string, buffer: ArrayBuffer): BookFormat {
  const cleanUrl = url.split('?')[0].toLowerCase()
  if (cleanUrl.endsWith('.epub')) return 'epub'
  if (cleanUrl.endsWith('.txt')) return 'txt'

  if (contentType.includes('application/epub+zip')) return 'epub'

  // Check ZIP header magic bytes (EPUB is a ZIP container starting with 0x50 0x4B 0x03 0x04)
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'epub'
  }

  return 'txt'
}

export function extractFilenameFromUrl(url: string, format: BookFormat): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (last) {
      const decoded = decodeURIComponent(last)
      return decoded.replace(/\.(epub|txt)$/i, '')
    }
  } catch {
    // Fallback
  }
  return `네트워크 문서 (${format.toUpperCase()})`
}

/**
 * Downloads a remote TXT or EPUB file for offline reading
 */
export async function downloadRemoteBook(
  url: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadedFileResult> {
  const trimmedUrl = url.trim()
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    throw new Error('유효한 HTTP/HTTPS URL을 입력해 주세요.')
  }

  let response: Response | null = null
  if (isTauriEnv()) {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      response = await tauriFetch(trimmedUrl, { method: 'GET' })
    } catch {
      response = null
    }
  }

  if (!response) {
    try {
      const proxyRes = await fetch('/__remote_proxy', {
        method: 'GET',
        headers: {
          'x-target-url': trimmedUrl,
          'x-target-method': 'GET'
        }
      })
      if (proxyRes.status !== 404) {
        response = proxyRes
      }
    } catch {
      // Fallback to direct fetch
    }
  }

  if (!response) {
    response = await fetch(trimmedUrl)
  }

  if (!response.ok) {
    throw new Error(`파일 다운로드 실패 (HTTP ${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  const contentLengthHeader = response.headers.get('content-length')
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loadedBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        loadedBytes += value.byteLength
        const percent = totalBytes > 0 ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100)) : 50
        onProgress?.({ loaded: loadedBytes, total: totalBytes, percent })
      }
    }

    const merged = new Uint8Array(loadedBytes)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }

    onProgress?.({ loaded: loadedBytes, total: loadedBytes, percent: 100 })
    const buffer = merged.buffer
    const format = inferBookFormat(trimmedUrl, contentType, buffer)
    const filename = extractFilenameFromUrl(trimmedUrl, format)

    return {
      buffer,
      filename,
      format,
      sourceUrl: trimmedUrl
    }
  }

  const buffer = await response.arrayBuffer()
  onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength, percent: 100 })
  const format = inferBookFormat(trimmedUrl, contentType, buffer)
  const filename = extractFilenameFromUrl(trimmedUrl, format)

  return {
    buffer,
    filename,
    format,
    sourceUrl: trimmedUrl
  }
}

