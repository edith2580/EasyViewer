import type { SearchResultItem, TocItem } from '@/types'

export interface TxtParagraph {
  index: number
  text: string
  startOffset: number
  endOffset: number
  isHeading: boolean
}

/**
 * A paragraph (or the part of one) shown on a page. `text`/offsets cover only the shown part;
 * `continued` is true when the paragraph started on a previous page.
 */
export interface TxtPageFragment extends TxtParagraph {
  continued: boolean
}

export interface TxtPage {
  pageNumber: number
  paragraphs: TxtPageFragment[]
  startOffset: number
  endOffset: number
  percentage: number
}

export interface TxtPaginationConfig {
  containerWidth: number
  containerHeight: number
  fontSize: number
  lineHeight: number
  pageMargin: number
}

/**
 * Automatically detects encoding (UTF-8, UTF-16LE/BE, or EUC-KR/CP949) and decodes ArrayBuffer to string.
 */
export function detectAndDecodeText(buffer: ArrayBuffer): { text: string; encoding: string } {
  const bytes = new Uint8Array(buffer)

  // Check BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'UTF-8 (BOM)'
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'UTF-16LE'
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'UTF-16BE'
    }
  }

  // Try strict UTF-8 first
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
    const decoded = utf8Decoder.decode(bytes)
    return { text: decoded, encoding: 'UTF-8' }
  } catch {
    // Fallback to EUC-KR (CP949) for Korean text files
    try {
      const euckrDecoder = new TextDecoder('euc-kr')
      return { text: euckrDecoder.decode(bytes), encoding: 'EUC-KR' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8 (Fallback)' }
    }
  }
}

//const HEADING_REGEX = /^(제\s*\d+\s*[장화편절부]|Chapter\s+\d+|CHAPTER\s+\d+|\[.+?\]|\d+\.\s+.+|#{1,3}\s+.+)/
const HEADING_REGEX = /^(제\s*\d+\s*[장화편절부]|\d+\s*화|CHAPTER\s+\d+|\d+\.\s+.+|#{1,3}\s+.+)/i;

/**
 * Parses raw text into structured paragraphs with character offsets and automatic chapter detection.
 */
export function parseTxtDocument(rawText: string): {
  paragraphs: TxtParagraph[]
  toc: TocItem[]
  totalLength: number
} {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rawLines = normalized.split('\n')
  const paragraphs: TxtParagraph[] = []
  const toc: TocItem[] = []

  let currentOffset = 0
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    const trimmed = line.trim()
    const startOffset = currentOffset
    const endOffset = currentOffset + line.length
    const isHeading = trimmed.length > 0 && trimmed.length <= 60 && HEADING_REGEX.test(trimmed)

    const paragraph: TxtParagraph = {
      index: i,
      text: line,
      startOffset,
      endOffset,
      isHeading
    }
    paragraphs.push(paragraph)

    if (isHeading) {
      toc.push({
        id: `txt-toc-${i}`,
        label: trimmed.replace(/^#{1,3}\s+/, ''),
        href: `offset:${startOffset}`,
        level: 0
      })
    }

    currentOffset = endOffset + 1 // +1 for '\n'
  }

  return {
    paragraphs,
    toc,
    totalLength: Math.max(1, currentOffset)
  }
}

/**
 * Estimates pages for Horizontal Paginated Mode from character counts. Only a fallback for when
 * the page can't be measured (see paginateTxtByLayout); the estimate can overflow a page.
 */
export function paginateTxtDocument(
  paragraphs: TxtParagraph[],
  totalLength: number,
  config: TxtPaginationConfig
): TxtPage[] {
  const usableWidth = Math.max(240, config.containerWidth - config.pageMargin * 2)
  const usableHeight = Math.max(240, config.containerHeight - config.pageMargin * 2 - 48)
  const linePx = config.fontSize * config.lineHeight
  const maxLinesPerPage = Math.max(5, Math.floor(usableHeight / linePx))
  const approxCharsPerLine = Math.max(15, Math.floor(usableWidth / (config.fontSize * 0.92)))

  const pages: TxtPage[] = []
  let currentParagraphs: TxtPageFragment[] = []
  let currentLines = 0

  for (const para of paragraphs) {
    const textLen = para.text.trim().length
    const paraLines =
      textLen === 0
        ? 0.6
        : Math.ceil(para.text.length / approxCharsPerLine) + (para.isHeading ? 1.2 : 0.35)

    if (currentLines + paraLines > maxLinesPerPage && currentParagraphs.length > 0) {
      const startOffset = currentParagraphs[0].startOffset
      const endOffset = currentParagraphs[currentParagraphs.length - 1].endOffset
      pages.push({
        pageNumber: pages.length + 1,
        paragraphs: currentParagraphs,
        startOffset,
        endOffset,
        percentage: Math.min(100, Math.round((endOffset / totalLength) * 1000) / 10)
      })
      currentParagraphs = [{ ...para, continued: false }]
      currentLines = paraLines
    } else {
      currentParagraphs.push({ ...para, continued: false })
      currentLines += paraLines
    }
  }

  if (currentParagraphs.length > 0) {
    const startOffset = currentParagraphs[0].startOffset
    const endOffset = currentParagraphs[currentParagraphs.length - 1].endOffset
    pages.push({
      pageNumber: pages.length + 1,
      paragraphs: currentParagraphs,
      startOffset,
      endOffset,
      percentage: 100
    })
  }

  if (pages.length === 0) {
    pages.push({
      pageNumber: 1,
      paragraphs: [],
      startOffset: 0,
      endOffset: 0,
      percentage: 100
    })
  }

  return pages
}

/**
 * Full-text search in TXT document with context snippet extraction
 */
export function searchTxtDocument(
  paragraphs: TxtParagraph[],
  totalLength: number,
  query: string,
  maxResults = 150
): SearchResultItem[] {
  const keyword = query.trim()
  if (!keyword) return []

  const lowerQuery = keyword.toLowerCase()
  const results: SearchResultItem[] = []
  let currentChapter = '본문'

  for (const para of paragraphs) {
    if (para.isHeading && para.text.trim()) {
      currentChapter = para.text.trim()
    }

    const lowerLine = para.text.toLowerCase()
    let searchStart = 0
    while (searchStart < lowerLine.length) {
      const matchPos = lowerLine.indexOf(lowerQuery, searchStart)
      if (matchPos === -1) break

      const snippetStart = Math.max(0, matchPos - 30)
      const snippetEnd = Math.min(para.text.length, matchPos + keyword.length + 45)
      const prefix = snippetStart > 0 ? '…' : ''
      const suffix = snippetEnd < para.text.length ? '…' : ''
      const excerpt = `${prefix}${para.text.slice(snippetStart, snippetEnd)}${suffix}`
      const absOffset = para.startOffset + matchPos

      results.push({
        id: `txt-hit-${para.index}-${matchPos}`,
        locator: `offset:${absOffset}`,
        excerpt,
        chapterTitle: currentChapter,
        percentage: Math.min(100, Math.round((absOffset / totalLength) * 1000) / 10),
        matchIndex: para.index
      })

      if (results.length >= maxResults) {
        return results
      }
      searchStart = matchPos + keyword.length
    }
  }

  return results
}

export function parseOffsetLocator(locator?: string): number {
  if (!locator) return 0
  if (locator.startsWith('offset:')) {
    const val = parseInt(locator.slice(7), 10)
    return Number.isFinite(val) ? val : 0
  }
  const num = parseInt(locator, 10)
  return Number.isFinite(num) ? num : 0
}

