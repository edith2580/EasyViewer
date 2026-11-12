import ePub, { EpubCFI, type Book, type NavItem, type Rendition } from 'epubjs'
import type { SearchResultItem, TocItem, ViewerSettings } from '@/types'
import { getStableScrollManager } from './stableScrollManager'

export interface EpubLocationChange {
  cfi: string
  percentage: number
  chapterTitle: string
  href: string
}

interface SpineSectionMetric {
  index: number
  href: string
  cfiBase: string
  weight: number
  startRatio: number
  endRatio: number
  locations: string[]
}

const FONT_STACK_MAP: Record<string, string> = {
  sans: '"Pretendard Variable", Pretendard, "Noto Sans KR", -apple-system, BlinkMacSystemFont, sans-serif',
  serif: '"Nanum Myeongjo", "Noto Serif KR", Georgia, serif',
  mono: '"D2Coding", Consolas, monospace',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
}

const THEME_PALETTE_MAP: Record<string, { bg: string; fg: string; link: string }> = {
  light: { bg: '#ffffff', fg: '#1e293b', link: '#4f46e5' },
  dark: { bg: '#111827', fg: '#e5e7eb', link: '#818cf8' },
  sepia: { bg: '#f4ecd8', fg: '#433422', link: '#8c5828' }
}

function normalizeToc(items: NavItem[], level = 0): TocItem[] {
  return (items || []).map((item, idx) => ({
    id: item.id || `toc-${level}-${idx}`,
    label: item.label.trim(),
    href: item.href,
    level,
    subitems: item.subitems && item.subitems.length > 0 ? normalizeToc(item.subitems, level + 1) : []
  }))
}

function collapseCfiString(cfiStr: string, toStart = true): string {
  if (!cfiStr || !cfiStr.startsWith('epubcfi(')) return cfiStr
  try {
    const parsed = new EpubCFI(cfiStr)
    if (parsed.range) {
      parsed.collapse(toStart)
      return parsed.toString()
    }
  } catch {
    // Fallback if CFI parsing fails
  }
  return cfiStr
}

export class EpubViewerEngine {
  private book: Book | null = null
  private rendition: Rendition | null = null
  private tocList: TocItem[] = []
  private locationsReady = false
  private sectionMetrics: SpineSectionMetric[] = []
  private activeHighlights: string[] = []
  private cfiHelper = new EpubCFI()
  private tapHandler: ((clientX: number, clientY: number) => void) | null = null
  private container: HTMLElement | null = null
  private onRelocated: ((loc: EpubLocationChange) => void) | null = null
  // View mode the current rendition was created with (the view manager differs per mode).
  private renderedViewMode: ViewerSettings['viewMode'] | null = null
  private rebuildPromise: Promise<void> | null = null

  /**
   * Registers a callback for plain taps/clicks inside the rendered EPUB iframe.
   * Coordinates are converted to the parent window's viewport. Taps on links/form controls
   * and clicks that end a text selection are not forwarded.
   */
  setTapHandler(handler: ((clientX: number, clientY: number) => void) | null): void {
    this.tapHandler = handler
  }

  private handleContentClick(event: MouseEvent, contents: any): void {
    if (!this.tapHandler) return
    const win: Window | null | undefined = contents?.document?.defaultView
    const selection = win?.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) return
    const target = event.target as Element | null
    if (target?.closest?.('a[href], button, input, textarea, select, label')) return

    const frameRect = (win?.frameElement as HTMLElement | null)?.getBoundingClientRect()
    this.tapHandler(event.clientX + (frameRect?.left ?? 0), event.clientY + (frameRect?.top ?? 0))
  }

  async loadBook(
    buffer: ArrayBuffer,
    container: HTMLElement,
    settings: ViewerSettings,
    initialLocator?: string,
    onRelocated?: (loc: EpubLocationChange) => void,
    initialPercentage?: number
  ): Promise<{
    title: string
    author: string
    toc: TocItem[]
  }> {
    this.destroy()

    const book = ePub(buffer.slice(0))
    this.book = book
    await book.ready

    const metadata = await book.loaded.metadata
    const navigation = await book.loaded.navigation
    this.tocList = normalizeToc(navigation?.toc || [])

    // Pre-generate character locations synchronously (pause = 0) BEFORE rendering any view.
    // This prevents locations.process() -> section.unload() from unloading active Rendition sections
    // and guarantees that sectionMetrics & locationsReady are ready before the first 'relocated' event.
    try {
      ;(book.locations as any).pause = 0
      await book.locations.generate(150)
      this.locationsReady = true
    } catch {
      this.locationsReady = false
    }
    this.buildSectionMetrics()

    this.container = container
    this.onRelocated = onRelocated || null
    const rendition = this.createRendition(settings, initialLocator, initialPercentage)

    if (initialLocator && initialLocator.startsWith('epubcfi(')) {
      const targetCfi = collapseCfiString(initialLocator, true)
      try {
        await rendition.display(targetCfi)
      } catch {
        await rendition.display()
      }
    } else if (initialLocator) {
      try {
        await rendition.display(this.resolveTargetHref(initialLocator))
      } catch {
        await rendition.display()
      }
    } else {
      await rendition.display()
    }

    return {
      title: metadata?.title || '제목 없는 EPUB',
      author: metadata?.creator || '작자 미상',
      toc: this.tocList
    }
  }

  /**
   * Scroll mode uses a 'continuous' view manager so that scrolling flows seamlessly from one
   * spine section into the next. ('scrolled-doc' shows a single section only, so scrolling
   * stopped at the end of each chapter — and image-only sections could not be scrolled past.)
   * See stableScrollManager.ts for how it keeps the position steady while sections load above.
   */
  private createRendition(
    settings: ViewerSettings,
    initialLocator?: string,
    initialPercentage?: number
  ): Rendition {
    if (!this.book || !this.container) throw new Error('EPUB book is not loaded')
    const isScroll = settings.viewMode === 'scroll'
    const rendition = this.book.renderTo(this.container, {
      width: '100%',
      height: '100%',
      manager: isScroll ? getStableScrollManager() : 'default',
      flow: isScroll ? 'scrolled' : 'paginated',
      spread: 'none',
      allowScriptedContent: false
    })
    this.rendition = rendition
    this.renderedViewMode = settings.viewMode

    this.applyTheme(settings)

    rendition.on('click', (event: MouseEvent, contents: any) =>
      this.handleContentClick(event, contents)
    )

    let isFirstRelocation = Boolean(initialLocator)

    rendition.on('relocated', (location: any) => {
      if (!location?.start) return
      const cfi: string = location.start.cfi || ''
      const href: string = location.start.href || ''
      let percentage = this.computeLocationPercentage(location)

      // Preserve saved non-zero percentage on initial reload if the restored locator is non-start
      if (
        isFirstRelocation &&
        initialLocator &&
        typeof initialPercentage === 'number' &&
        initialPercentage > 0 &&
        percentage === 0 &&
        !location.atStart
      ) {
        percentage = Math.min(100, Math.max(0, Math.round(initialPercentage * 10) / 10))
      }
      isFirstRelocation = false

      const chapterTitle = this.findChapterLabelByHref(href, location.start.index)
      this.onRelocated?.({
        cfi,
        percentage,
        chapterTitle,
        href
      })
    })

    return rendition
  }

  /** Re-creates the rendition (e.g. paginated ↔ scroll needs a different view manager), keeping the reading position. */
  private async rebuildRendition(settings: ViewerSettings): Promise<void> {
    if (!this.book || !this.container || !this.rendition) return
    const currentCfi: string | undefined = (this.rendition as any).location?.start?.cfi
    try {
      this.rendition.destroy()
    } catch {
      // Ignore
    }
    this.activeHighlights = []
    const rendition = this.createRendition(settings)
    try {
      await rendition.display(currentCfi ? collapseCfiString(currentCfi, true) : undefined)
    } catch {
      await rendition.display()
    }
  }

  private buildSectionMetrics(): void {
    this.sectionMetrics = []
    if (!this.book) return

    const spineItems = this.book.spine.spineItems || []
    if (spineItems.length === 0) return

    const rawLocations: string[] = Array.isArray((this.book.locations as any)?._locations)
      ? ((this.book.locations as any)._locations as string[])
      : []

    const groupedBySpine = new Map<number, string[]>()
    for (const loc of rawLocations) {
      try {
        const parsed = new EpubCFI(loc)
        const spineIdx = parsed.spinePos
        if (typeof spineIdx === 'number' && spineIdx >= 0) {
          const collapsed = collapseCfiString(loc, true)
          const list = groupedBySpine.get(spineIdx) || []
          list.push(collapsed)
          groupedBySpine.set(spineIdx, list)
        }
      } catch {
        // Ignore malformed CFI
      }
    }

    const totalSections = spineItems.length
    const weights = spineItems.map((item) => {
      const locs = groupedBySpine.get(item.index) || []
      return Math.max(1, locs.length)
    })
    const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1

    let cumulative = 0
    for (let i = 0; i < totalSections; i++) {
      const item = spineItems[i]
      const weight = weights[i]
      const locs = groupedBySpine.get(item.index) || []
      const startRatio = cumulative / totalWeight
      cumulative += weight
      const endRatio = i === totalSections - 1 ? 1 : cumulative / totalWeight

      this.sectionMetrics.push({
        index: item.index,
        href: item.href,
        cfiBase: item.cfiBase,
        weight,
        startRatio,
        endRatio,
        locations: locs
      })
    }
  }

  private resolveSectionIndex(cfi?: string, href?: string, explicitIndex?: number): number {
    if (
      typeof explicitIndex === 'number' &&
      explicitIndex >= 0 &&
      explicitIndex < this.sectionMetrics.length
    ) {
      return explicitIndex
    }

    if (cfi && cfi.startsWith('epubcfi(')) {
      try {
        const parsed = new EpubCFI(cfi)
        if (
          typeof parsed.spinePos === 'number' &&
          parsed.spinePos >= 0 &&
          parsed.spinePos < this.sectionMetrics.length
        ) {
          return parsed.spinePos
        }
      } catch {
        // Fallback to href matching
      }
    }

    if (href) {
      const cleanHref = href.split('#')[0]
      const found = this.sectionMetrics.find(
        (m) => m.href === cleanHref || m.href.endsWith(cleanHref) || cleanHref.endsWith(m.href)
      )
      if (found) return found.index
    }

    return 0
  }

  private computeLocationPercentage(location: any): number {
    if (!location?.start) return 0

    const totalSections = this.sectionMetrics.length
    if (totalSections === 0) return 0

    const startCfi: string = location.start.cfi || ''
    const startHref: string = location.start.href || ''
    const sectionIdx = this.resolveSectionIndex(startCfi, startHref, location.start.index)
    const metric = this.sectionMetrics[sectionIdx] || this.sectionMetrics[0]

    const startPage = Math.max(1, Number(location.start?.displayed?.page) || 1)
    const totalPages = Math.max(1, Number(location.start?.displayed?.total) || 1)
    const endPage = Math.max(startPage, Number(location.end?.displayed?.page) || startPage)
    const endTotalPages = Math.max(totalPages, Number(location.end?.displayed?.total) || totalPages)

    // Compute intra-section ratio (0 .. 1) from both displayed page and CFI location inside the section
    let cfiIntraRatio = 0
    if (metric.locations.length > 1 && startCfi) {
      const pointCfi = collapseCfiString(startCfi, true)
      let matchedIdx = 0
      for (let i = 0; i < metric.locations.length; i++) {
        try {
          if (this.cfiHelper.compare(metric.locations[i], pointCfi) <= 0) {
            matchedIdx = i
          } else {
            break
          }
        } catch {
          // Ignore comparison error
        }
      }
      cfiIntraRatio = matchedIdx / Math.max(1, metric.locations.length - 1)
    }

    // Very start of the first section
    if (sectionIdx === 0 && startPage === 1 && cfiIntraRatio === 0) {
      return 0
    }

    // Very end of the last section
    if (location.atEnd || (sectionIdx === totalSections - 1 && endPage >= endTotalPages && (totalSections > 1 || endTotalPages > 1))) {
      return 100
    }

    let intraRatio = 0
    if (totalPages > 1) {
      if (sectionIdx === totalSections - 1) {
        intraRatio = (startPage - 1) / Math.max(1, totalPages - 1)
      } else {
        intraRatio = (startPage - 1) / totalPages
      }
    } else {
      intraRatio = sectionIdx === totalSections - 1 ? cfiIntraRatio : cfiIntraRatio * 0.95
    }

    const globalRatio = metric.startRatio + (metric.endRatio - metric.startRatio) * Math.max(0, Math.min(1, intraRatio))
    return Math.min(100, Math.max(0, Math.round(globalRatio * 1000) / 10))
  }

  private computeCfiPercentage(cfi: string, fallbackSectionIdx = 0): number {
    if (!cfi || this.sectionMetrics.length === 0) return 0
    const sectionIdx = this.resolveSectionIndex(cfi, undefined, fallbackSectionIdx)
    const metric = this.sectionMetrics[sectionIdx] || this.sectionMetrics[0]

    let cfiIntraRatio = 0
    if (metric.locations.length > 1) {
      const pointCfi = collapseCfiString(cfi, true)
      let matchedIdx = 0
      for (let i = 0; i < metric.locations.length; i++) {
        try {
          if (this.cfiHelper.compare(metric.locations[i], pointCfi) <= 0) {
            matchedIdx = i
          } else {
            break
          }
        } catch {
          // Ignore
        }
      }
      cfiIntraRatio = matchedIdx / Math.max(1, metric.locations.length)
    }

    const globalRatio = metric.startRatio + (metric.endRatio - metric.startRatio) * cfiIntraRatio
    return Math.min(100, Math.max(0, Math.round(globalRatio * 1000) / 10))
  }

  private resolveTargetHref(target: string): string {
    if (!target || target.startsWith('epubcfi(') || !this.book) return target
    if (this.book.spine.get(target)) return target

    const [rawPath, hash] = target.split('#')
    const cleanPath = rawPath.replace(/^(\.\.\/|\.\/)+/, '')
    const matched = (this.book.spine.spineItems || []).find(
      (item) =>
        item.href === cleanPath ||
        item.href.endsWith(cleanPath) ||
        cleanPath.endsWith(item.href) ||
        (item.canonical && item.canonical.endsWith(cleanPath))
    )
    if (matched) {
      return hash ? `${matched.href}#${hash}` : matched.href
    }
    return target
  }

  applySettings(settings: ViewerSettings): void {
    if (!this.rendition) return
    if (settings.viewMode !== this.renderedViewMode) {
      // Serialize rebuilds so rapid toggles don't interleave destroy/display.
      const prev = this.rebuildPromise || Promise.resolve()
      this.rebuildPromise = prev
        .then(() => (settings.viewMode !== this.renderedViewMode ? this.rebuildRendition(settings) : undefined))
        .catch(() => undefined)
      return
    }
    this.applyTheme(settings)
    this.rendition.flow(settings.viewMode === 'scroll' ? 'scrolled' : 'paginated')
  }

  private applyTheme(settings: ViewerSettings): void {
    if (!this.rendition) return
    const palette = THEME_PALETTE_MAP[settings.theme] || THEME_PALETTE_MAP.light
    const fontStack = FONT_STACK_MAP[settings.fontFamily] || FONT_STACK_MAP.sans

    this.rendition.themes.default({
      body: {
        'background-color': `${palette.bg} !important`,
        color: `${palette.fg} !important`,
        'font-family': `${fontStack} !important`,
        'font-size': `${settings.fontSize}px !important`,
        'line-height': `${settings.lineHeight} !important`,
        padding: `12px ${settings.pageMargin}px !important`
      },
      p: {
        'font-family': `${fontStack} !important`,
        'line-height': `${settings.lineHeight} !important`,
        color: `${palette.fg} !important`
      },
      a: {
        color: `${palette.link} !important`
      }
    })
  }

  async next(): Promise<void> {
    await this.rendition?.next()
  }

  async prev(): Promise<void> {
    await this.rendition?.prev()
  }

  async goTo(target: string): Promise<void> {
    if (!this.rendition || !target) return
    const normalized = target.startsWith('epubcfi(')
      ? collapseCfiString(target, true)
      : this.resolveTargetHref(target)
    await this.rendition.display(normalized)
  }

  async goToPercentage(percentage: number): Promise<void> {
    if (!this.book || !this.rendition) return
    const clamped = Math.max(0, Math.min(100, percentage))

    if (this.sectionMetrics.length === 0) {
      this.buildSectionMetrics()
    }
    if (this.sectionMetrics.length === 0) return

    if (clamped <= 0) {
      await this.rendition.display(this.sectionMetrics[0].href)
      return
    }

    if (clamped >= 100) {
      const lastMetric = this.sectionMetrics[this.sectionMetrics.length - 1]
      if (lastMetric.locations.length > 0) {
        const lastCfi = lastMetric.locations[lastMetric.locations.length - 1]
        await this.rendition.display(collapseCfiString(lastCfi, false))
      } else {
        await this.rendition.display(lastMetric.href)
      }
      return
    }

    const targetRatio = clamped / 100
    const metric =
      this.sectionMetrics.find((m) => targetRatio >= m.startRatio && targetRatio < m.endRatio) ||
      this.sectionMetrics[this.sectionMetrics.length - 1]

    const span = Math.max(0.0001, metric.endRatio - metric.startRatio)
    const localRatio = Math.max(0, Math.min(0.999, (targetRatio - metric.startRatio) / span))

    if (metric.locations.length > 1 && localRatio > 0.02) {
      const locIdx = Math.min(
        metric.locations.length - 1,
        Math.max(0, Math.floor(localRatio * metric.locations.length))
      )
      const targetCfi = collapseCfiString(metric.locations[locIdx], true)
      await this.rendition.display(targetCfi)
    } else {
      await this.rendition.display(metric.href)
    }
  }

  highlightSearchCfi(cfi: string): void {
    if (!this.rendition) return
    for (const oldCfi of this.activeHighlights) {
      try {
        this.rendition.annotations.remove(oldCfi, 'highlight')
      } catch {
        // Ignore removal errors
      }
    }
    this.activeHighlights = []

    if (cfi && cfi.startsWith('epubcfi(')) {
      try {
        this.rendition.annotations.highlight(
          cfi,
          {},
          undefined,
          'easyviewer-epub-highlight',
          {
            fill: '#facc15',
            'fill-opacity': '0.45',
            'mix-blend-mode': 'multiply'
          }
        )
        this.activeHighlights.push(cfi)
      } catch {
        // Ignore highlight error
      }
    }
  }

  /**
   * Asynchronous full-text search across all spine sections of the EPUB
   */
  async search(query: string, maxResults = 100): Promise<SearchResultItem[]> {
    const keyword = query.trim()
    if (!this.book || !keyword) return []

    const results: SearchResultItem[] = []
    const spineItems = this.book.spine.spineItems || []

    for (const item of spineItems) {
      try {
        await item.load(this.book.load.bind(this.book))
        const matches = item.find(keyword) || []
        const chapterTitle = this.findChapterLabelByHref(item.href, item.index)

        for (let i = 0; i < matches.length; i++) {
          const match = matches[i]
          const percentage = this.computeCfiPercentage(match.cfi, item.index)
          results.push({
            id: `epub-hit-${item.index}-${i}`,
            locator: match.cfi,
            excerpt: match.excerpt?.trim() || keyword,
            chapterTitle,
            percentage
          })
          if (results.length >= maxResults) {
            item.unload()
            return results
          }
        }
        item.unload()
      } catch {
        // Continue on individual section error
      }
    }

    return results
  }

  private findChapterLabelByHref(href: string, spineIndex?: number): string {
    if (href) {
      const cleanHref = href.split('#')[0]
      const searchTree = (items: TocItem[]): string | null => {
        for (const item of items) {
          const itemHref = item.href.split('#')[0]
          if (cleanHref.endsWith(itemHref) || itemHref.endsWith(cleanHref)) {
            return item.label
          }
          if (item.subitems?.length) {
            const subFound = searchTree(item.subitems)
            if (subFound) return subFound
          }
        }
        return null
      }
      const matched = searchTree(this.tocList)
      if (matched) return matched
    }

    if (typeof spineIndex === 'number' && this.tocList[spineIndex]) {
      return this.tocList[spineIndex].label
    }
    return '본문'
  }

  destroy(): void {
    try {
      this.rendition?.destroy()
    } catch {
      // Ignore
    }
    try {
      this.book?.destroy()
    } catch {
      // Ignore
    }
    this.rendition = null
    this.book = null
    this.container = null
    this.renderedViewMode = null
    this.rebuildPromise = null
    this.locationsReady = false
    this.sectionMetrics = []
    this.activeHighlights = []
  }
}

/**
 * Extracts metadata (title, author, cover data URL) from an EPUB ArrayBuffer before opening in viewer
 */
export async function extractEpubMetadata(buffer: ArrayBuffer): Promise<{
  title: string
  author: string
  coverUrl?: string
}> {
  const book = ePub(buffer.slice(0))
  try {
    await book.ready
    const meta = await book.loaded.metadata
    let coverUrl: string | undefined
    try {
      const blobUrl = await book.coverUrl()
      if (blobUrl) {
        const res = await fetch(blobUrl)
        const blob = await res.blob()
        coverUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '')
          reader.readAsDataURL(blob)
        })
      }
    } catch {
      // Optional cover
    }
    const result = {
      title: meta?.title?.trim() || '제목 없는 EPUB',
      author: meta?.creator?.trim() || '작자 미상',
      coverUrl: coverUrl || undefined
    }
    book.destroy()
    return result
  } catch {
    try {
      book.destroy()
    } catch {
      // Ignore
    }
    return {
      title: 'EPUB 문서',
      author: '작자 미상'
    }
  }
}

