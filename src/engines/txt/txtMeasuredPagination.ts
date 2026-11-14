import type { TxtPage, TxtPageFragment, TxtParagraph } from './txtEngine'

/**
 * Layout-affecting classes of a paragraph on a TXT page. The page template and the off-screen
 * measurer must use exactly the same ones, otherwise the measured line breaks won't match what
 * is displayed. (Colors and other purely visual classes are added only in the template.)
 */
export const TXT_PAGE_PARA_CLASS = 'mb-2.5 break-words'
export const TXT_PAGE_HEADING_CLASS = 'font-bold text-[1.15em] mt-2 mb-2'

interface Pos {
  para: number
  char: number
}

interface LineBox {
  top: number
  bottom: number
}

interface MeasureWindow {
  els: HTMLParagraphElement[]
  tops: number[]
  bottoms: number[]
  marginTop(k: number): number
  lineBoxes(k: number): LineBox[]
  /** Local char index (within element k's text) of the first character on line `lineIdx`. */
  charAtLine(k: number, lines: LineBox[], lineIdx: number): number
  /** Index of the line that local char `c` of element k is rendered on. */
  lineOfChar(k: number, lines: LineBox[], c: number): number
}

interface StepResult {
  pages: TxtPage[]
  next: Pos
  atEnd: boolean
  atStop: boolean
}

/**
 * Measures TXT pages against the real layout of the page element.
 *
 * Paragraphs are rendered off-screen inside the page element (so they inherit exactly the same
 * font, size, line height and width as the visible page) and each page ends at its last fully
 * visible line. A paragraph that doesn't fit is split at a real line break and continues on the
 * next page, so no line is ever clipped or skipped.
 */
export class TxtPageMeasurer {
  readonly valid: boolean
  private readonly contentWidth: number
  private readonly pageHeight: number
  private readonly n: number
  private measurerEl: HTMLDivElement | null = null
  private range: Range | null = null

  constructor(
    private readonly paragraphs: TxtParagraph[],
    readonly totalLength: number,
    private readonly pageEl: HTMLElement
  ) {
    const cs = getComputedStyle(pageEl)
    this.contentWidth =
      pageEl.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')
    this.pageHeight =
      pageEl.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')
    this.n = paragraphs.length
    this.valid = this.contentWidth >= 40 && this.pageHeight >= 40 && this.n > 0
  }

  // ------------------------------------------------------------------ positions

  /** Paragraph/char position of an absolute char offset (end of book = { para: n, char: 0 }). */
  posOf(offset: number): Pos {
    const paras = this.paragraphs
    if (offset >= this.totalLength || this.n === 0) return { para: this.n, char: 0 }
    let low = 0
    let high = this.n - 1
    while (low < high) {
      const mid = (low + high + 1) >>> 1
      if (paras[mid].startOffset <= offset) low = mid
      else high = mid - 1
    }
    const para = paras[low]
    const char = Math.max(0, offset - para.startOffset)
    // The newline after a paragraph belongs to the start of the next one.
    if (char > 0 && char >= para.text.length) return { para: low + 1, char: 0 }
    return { para: low, char }
  }

  absOf(pos: Pos): number {
    if (pos.para >= this.n) return this.totalLength
    return this.paragraphs[pos.para].startOffset + pos.char
  }

  /** Absolute offset where the page after `page` starts. */
  nextStartOf(page: TxtPage): number {
    const last = page.paragraphs[page.paragraphs.length - 1]
    if (!last) return page.endOffset
    const para = this.paragraphs[last.index] // paragraph index === array position
    if (para && last.endOffset < para.endOffset) return last.endOffset
    return para ? Math.min(this.totalLength, para.endOffset + 1) : last.endOffset
  }

  // ------------------------------------------------------------------ measuring primitives

  private attach(): void {
    if (this.measurerEl) return
    const el = document.createElement('div')
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      `width:${this.contentWidth}px`,
      'padding:0',
      'margin:0',
      'border:0',
      'visibility:hidden',
      'pointer-events:none',
      'contain:layout style'
    ].join(';')
    this.pageEl.appendChild(el)
    this.measurerEl = el
    this.range = document.createRange()
  }

  private detach(): void {
    this.measurerEl?.remove()
    this.measurerEl = null
    this.range = null
  }

  private withMeasurer<T>(fn: () => T): T {
    this.attach()
    try {
      return fn()
    } finally {
      this.detach()
    }
  }

  /**
   * Renders paragraphs [from.para, toParaExcl) like a page would: the first one starting at
   * from.char (as a continuation without top margin), the last one optionally cut at lastChar.
   */
  private renderWindow(from: Pos, toParaExcl: number, lastChar = -1): MeasureWindow {
    const measurer = this.measurerEl!
    const range = this.range!
    measurer.textContent = ''
    const els: HTMLParagraphElement[] = []
    const frag = document.createDocumentFragment()
    for (let p = from.para; p < toParaExcl; p++) {
      const para = this.paragraphs[p]
      const el = document.createElement('p')
      el.className = para.isHeading
        ? `${TXT_PAGE_PARA_CLASS} ${TXT_PAGE_HEADING_CLASS}`
        : TXT_PAGE_PARA_CLASS
      let text = para.text
      if (p === toParaExcl - 1 && lastChar >= 0) text = text.slice(0, lastChar)
      if (p === from.para && from.char > 0) {
        text = text.slice(from.char)
        el.style.marginTop = '0'
      }
      el.textContent = text || ' '
      frag.appendChild(el)
      els.push(el)
    }
    measurer.appendChild(frag)

    const originTop = measurer.getBoundingClientRect().top
    const tops: number[] = []
    const bottoms: number[] = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      tops.push(r.top - originTop)
      bottoms.push(r.bottom - originTop)
    }
    const marginCache = new Map<string, number>()
    const marginTop = (k: number): number => {
      const el = els[k]
      if (el.style.marginTop === '0') return 0
      let v = marginCache.get(el.className)
      if (v === undefined) {
        v = parseFloat(getComputedStyle(el).marginTop) || 0
        marginCache.set(el.className, v)
      }
      return v
    }
    const lineBoxes = (k: number): LineBox[] => {
      range.selectNodeContents(els[k])
      const lines: LineBox[] = []
      for (const r of Array.from(range.getClientRects())) {
        if (r.height <= 0) continue
        const top = r.top - originTop
        const bottom = r.bottom - originTop
        const last = lines[lines.length - 1]
        if (last && top < last.bottom - 1) {
          last.top = Math.min(last.top, top)
          last.bottom = Math.max(last.bottom, bottom)
        } else {
          lines.push({ top, bottom })
        }
      }
      return lines.length > 0 ? lines : [{ top: tops[k], bottom: bottoms[k] }]
    }
    const charTop = (k: number, c: number): number => {
      const node = els[k].firstChild
      if (!node) return Infinity
      const len = node.textContent?.length ?? 0
      for (let i = c; i < len; i++) {
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const r = range.getBoundingClientRect()
        if (r.height > 0) return r.top - originTop
      }
      return Infinity
    }
    const charAtLine = (k: number, lines: LineBox[], lineIdx: number): number => {
      const node = els[k].firstChild
      if (!node || lineIdx <= 0) return 0
      const text = node.textContent || ''
      const threshold = lines[lineIdx].top - 1
      let lo = 0
      let hi = text.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (charTop(k, mid) >= threshold) hi = mid
        else lo = mid + 1
      }
      // Never split a surrogate pair.
      if (lo > 0 && lo < text.length) {
        const code = text.charCodeAt(lo)
        if (code >= 0xdc00 && code <= 0xdfff) lo--
      }
      return lo
    }
    const lineOfChar = (k: number, lines: LineBox[], c: number): number => {
      const top = charTop(k, c)
      let idx = 0
      for (let l = 0; l < lines.length; l++) if (lines[l].top <= top + 1) idx = l
      return idx
    }
    return { els, tops, bottoms, marginTop, lineBoxes, charAtLine, lineOfChar }
  }

  /** Page fragments from `from` up to (excluding) `to`. */
  private buildPage(from: Pos, to: Pos): TxtPage {
    const fragments: TxtPageFragment[] = []
    const lastPara = Math.min(to.para, this.n - 1)
    for (let p = from.para; p <= lastPara; p++) {
      const para = this.paragraphs[p]
      const start = p === from.para ? from.char : 0
      let end = para.text.length
      if (p === to.para) {
        if (to.char === 0) break
        end = to.char
      }
      fragments.push({
        index: para.index,
        text: para.text.slice(start, end),
        startOffset: para.startOffset + start,
        endOffset: para.startOffset + end,
        isHeading: para.isHeading,
        continued: start > 0
      })
    }
    const startOffset = fragments.length ? fragments[0].startOffset : this.absOf(from)
    const endOffset = fragments.length ? fragments[fragments.length - 1].endOffset : startOffset
    return {
      pageNumber: 0,
      paragraphs: fragments,
      startOffset,
      endOffset,
      percentage:
        to.para >= this.n
          ? 100
          : Math.min(100, Math.round((endOffset / Math.max(1, this.totalLength)) * 1000) / 10)
    }
  }

  // ------------------------------------------------------------------ public measuring API

  /**
   * Paginates forward from `from`, measuring about `windowSize` paragraphs. Returns the pages
   * that are fully determined and where to continue. A page never crosses `stopOffset`: the
   * chain is cut there (forced page break) and `atStop` is set.
   */
  step(from: Pos, stopOffset: number | null, windowSize: number): StepResult {
    return this.withMeasurer(() => {
      let size = Math.max(8, windowSize)
      for (;;) {
        const res = this.stepOnce(from, stopOffset, size)
        if (res.pages.length > 0 || res.atEnd || res.atStop) return res
        size *= 2 // a single page needs more paragraphs than the window held
      }
    })
  }

  private stepOnce(from: Pos, stopOffset: number | null, windowSize: number): StepResult {
    const pages: TxtPage[] = []
    if (from.para >= this.n) return { pages, next: from, atEnd: true, atStop: false }
    const stop = stopOffset !== null && stopOffset > this.absOf(from) ? stopOffset : null
    const stopPos = stop !== null ? this.posOf(stop) : null

    const winEnd = Math.min(this.n, from.para + windowSize)
    const w = this.renderWindow(from, winEnd)
    const H = this.pageHeight
    const posAt = (k: number, char: number): Pos => ({ para: from.para + k, char })

    let i = 0
    let char = from.char
    let pageTop = 0

    /** Emits [start, end); cuts at the stop when it lies inside. Returns true if cut. */
    const emit = (end: Pos): boolean => {
      const start = posAt(i, char)
      if (stop !== null && stop <= this.absOf(end)) {
        pages.push(this.buildPage(start, stopPos!))
        return true
      }
      pages.push(this.buildPage(start, end))
      return false
    }

    while (i < w.els.length) {
      const limit = pageTop + H
      let j = i
      while (j < w.els.length && w.bottoms[j] <= limit + 0.5) j++

      if (j === w.els.length) {
        const windowEnd: Pos = { para: winEnd, char: 0 }
        if (winEnd === this.n) {
          const cut = emit(windowEnd)
          return cut
            ? { pages, next: stopPos!, atEnd: false, atStop: true }
            : { pages, next: windowEnd, atEnd: true, atStop: false }
        }
        if (stop !== null && stop <= this.absOf(windowEnd)) {
          emit(windowEnd) // always cut: the stop lies inside content that fits
          return { pages, next: stopPos!, atEnd: false, atStop: true }
        }
        // The page continues past this window: re-measure from the page start next time.
        return { pages, next: posAt(i, char), atEnd: false, atStop: false }
      }

      const lines = w.lineBoxes(j)
      let firstLine = 0
      while (firstLine < lines.length && lines[firstLine].top < pageTop - 1) firstLine++
      let fit = firstLine
      while (fit < lines.length && lines[fit].bottom <= limit + 0.5) fit++

      let end: Pos
      let nextTop: number
      if (fit === firstLine && j > i) {
        // Not a single line of element j fits: the page ends right before it.
        end = posAt(j, 0)
        nextTop = w.tops[j] - w.marginTop(j)
      } else {
        if (fit === firstLine) fit = firstLine + 1 // tiny page: take one line anyway
        if (fit >= lines.length) {
          end = posAt(j + 1, 0)
          nextTop = j + 1 < w.els.length ? w.tops[j + 1] - w.marginTop(j + 1) : w.bottoms[j]
        } else {
          const base = j === 0 ? from.char : 0
          const splitChar = base + w.charAtLine(j, lines, fit)
          if (j === i && splitChar <= char) {
            end = posAt(j + 1, 0) // safety net: always progress
            nextTop = j + 1 < w.els.length ? w.tops[j + 1] - w.marginTop(j + 1) : w.bottoms[j]
          } else {
            end = posAt(j, splitChar)
            nextTop = (lines[fit - 1].bottom + lines[fit].top) / 2
          }
        }
      }

      if (emit(end)) return { pages, next: stopPos!, atEnd: false, atStop: true }
      i = end.para - from.para
      char = end.char
      pageTop = nextTop
    }

    return { pages, next: { para: winEnd, char: 0 }, atEnd: winEnd >= this.n, atStop: false }
  }

  /** The page that ends exactly where `endOffset` starts, filled backward from there. */
  pageEndingAt(endOffset: number): TxtPage | null {
    if (endOffset <= 0) return null
    const end = this.posOf(endOffset)
    const lastPara = end.char > 0 ? end.para : end.para - 1
    if (lastPara < 0) return null
    const lastChar = end.char > 0 ? end.char : -1

    return this.withMeasurer(() => {
      let count = 40
      for (;;) {
        const p0 = Math.max(0, lastPara - count + 1)
        const w = this.renderWindow({ para: p0, char: 0 }, lastPara + 1, lastChar)
        const last = w.els.length - 1
        const lastLines = w.lineBoxes(last)
        const bottom = lastLines[lastLines.length - 1].bottom
        const threshold = bottom - this.pageHeight - 0.5

        if (w.tops[0] - w.marginTop(0) < threshold || p0 === 0) {
          // Earliest page-start candidate (paragraph start or line start) at/below the threshold.
          let start: Pos | null = null
          if (w.tops[0] - w.marginTop(0) >= threshold) start = { para: p0, char: 0 }
          for (let k = 0; !start && k <= last; k++) {
            if (w.tops[k] - w.marginTop(k) >= threshold) {
              start = { para: p0 + k, char: 0 }
              break
            }
            if (w.bottoms[k] <= threshold) continue
            const lines = k === last ? lastLines : w.lineBoxes(k)
            for (let l = 1; l < lines.length; l++) {
              if ((lines[l - 1].bottom + lines[l].top) / 2 >= threshold) {
                start = { para: p0 + k, char: w.charAtLine(k, lines, l) }
                break
              }
            }
          }
          if (!start || this.absOf(start) >= endOffset) {
            // Not even one line fits: take the last line anyway.
            const l = lastLines.length - 1
            start = { para: lastPara, char: w.charAtLine(last, lastLines, l) }
          }
          return this.buildPage(start, end)
        }
        count *= 2
      }
    })
  }

  /** Start of the natural line (as laid out from its paragraph start) that contains `offset`. */
  snapToLineStart(offset: number): number {
    const pos = this.posOf(offset)
    if (pos.para >= this.n || pos.char === 0) return this.absOf(pos)
    return this.withMeasurer(() => {
      const w = this.renderWindow({ para: pos.para, char: 0 }, pos.para + 1)
      const lines = w.lineBoxes(0)
      const line = w.lineOfChar(0, lines, pos.char)
      return this.absOf({ para: pos.para, char: w.charAtLine(0, lines, line) })
    })
  }
}

export interface TxtPaginationState {
  page: TxtPage | null
  /** 1-based page number, null while the page index is still being computed. */
  pageNumber: number | null
  totalPages: number | null
  /** 0..1 progress of the background page index. */
  progress: number
  hasPrev: boolean
  hasNext: boolean
}

/** Rough per-tick budget for background pagination work. */
const BG_TICK_MS = 16
/** Paragraphs measured synchronously when a page turn needs pages not computed yet. */
const SYNC_WINDOW = 40

/**
 * Paginated TXT reading session.
 *
 * The page at the reading position is measured and shown immediately; the full page index is
 * built in the background in small chunks. The index is forced to break at the reading position
 * (and at any page start reached by going backward before it finished), so the page on screen
 * never changes when the index completes — only the page number appears.
 */
export class TxtPaginationSession {
  private readonly measurer: TxtPageMeasurer
  private destroyed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private bgWindow = 60

  // Final page list once the index is complete.
  private allPages: TxtPage[] | null = null
  private currentIdx = 0

  // While indexing:
  private pinStart = 0 // P: where the forward chain starts
  private pins: number[] = [] // forced page breaks (sorted)
  private bPages: TxtPage[] = [] // chain from the book start up to P
  private bCursor: Pos = { para: 0, char: 0 }
  private bCursorAbs = 0
  private detached: TxtPage[] = [] // pages filled backward from P, not yet reached by the B chain
  private fPages: TxtPage[] = [] // chain from P to the end
  private fCursor: Pos = { para: 0, char: 0 }
  private fDone = false
  private current: TxtPage | null = null
  /** Background indexing runs only once enabled (e.g. after web fonts are ready). */
  private backgroundEnabled: boolean

  constructor(
    private readonly paragraphs: TxtParagraph[],
    private readonly totalLength: number,
    pageEl: HTMLElement,
    targetOffset: number,
    private readonly onChange: (state: TxtPaginationState) => void,
    fallback: () => TxtPage[],
    options: { deferBackground?: boolean } = {}
  ) {
    this.backgroundEnabled = !options.deferBackground
    this.measurer = new TxtPageMeasurer(paragraphs, totalLength, pageEl)
    if (!this.measurer.valid) {
      this.useIndex(fallback(), targetOffset)
      return
    }
    this.startAt(targetOffset)
  }

  get state(): TxtPaginationState {
    const ready = this.allPages !== null
    const page = this.current
    const progressed =
      this.bCursorAbs + Math.max(0, this.measurer.absOf(this.fCursor) - this.pinStart)
    return {
      page,
      pageNumber: ready ? this.currentIdx + 1 : null,
      totalPages: ready ? this.allPages!.length : null,
      progress: ready ? 1 : Math.min(0.99, progressed / Math.max(1, this.totalLength)),
      hasPrev: !!page && page.startOffset > 0,
      hasNext: !!page && this.measurer.nextStartOf(page) < this.totalLength
    }
  }

  /** Starts building the page index in the background (if it was deferred). */
  startBackground(): void {
    this.backgroundEnabled = true
    this.schedule()
  }

  /** Start offset of the page on screen. */
  get currentStartOffset(): number | null {
    return this.current?.startOffset ?? null
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  next(): boolean {
    const page = this.current
    if (!page) return false
    if (this.allPages) {
      if (this.currentIdx >= this.allPages.length - 1) return false
      this.currentIdx++
      this.current = this.allPages[this.currentIdx]
      this.emit()
      return true
    }
    const start = this.measurer.nextStartOf(page)
    if (start >= this.totalLength) return false
    let found = this.findByStart(start)
    while (!found) {
      if (start >= this.pinStart) {
        if (this.fDone) break
        this.stepF(SYNC_WINDOW)
      } else {
        if (this.bCursorAbs >= this.pinStart) break
        this.stepB(SYNC_WINDOW)
      }
      found = this.findByStart(start)
    }
    if (!found) return false
    this.current = found
    this.checkReady()
    this.emit()
    return true
  }

  prev(): boolean {
    const page = this.current
    if (!page || page.startOffset <= 0) return false
    if (this.allPages) {
      if (this.currentIdx <= 0) return false
      this.currentIdx--
      this.current = this.allPages[this.currentIdx]
      this.emit()
      return true
    }
    const s = page.startOffset
    let found = this.findEndingAt(s)
    if (!found) {
      // s is the earliest known page start and the background chain hasn't reached it yet.
      const back = this.measurer.pageEndingAt(s)
      if (!back) return false
      if (back.startOffset <= this.bCursorAbs) {
        // The background chain is less than a page away: finish that bit now.
        while (this.bCursorAbs < s && this.bCursorAbs < this.pinStart) this.stepB(SYNC_WINDOW)
        found = this.findEndingAt(s)
      } else {
        this.addPin(back.startOffset)
        this.detached.unshift(back)
        found = back
      }
    }
    if (!found) return false
    this.current = found
    this.checkReady()
    this.emit()
    return true
  }

  /** Shows the page containing `offset` (restarting the session there if it isn't known yet). */
  goToOffset(offset: number): void {
    if (this.allPages) {
      this.currentIdx = indexByStart(this.allPages, offset)
      this.current = this.allPages[this.currentIdx]
      this.emit()
      return
    }
    const known = this.findContaining(offset)
    if (known) {
      this.current = known
      this.emit()
      return
    }
    this.startAt(offset)
  }

  // ------------------------------------------------------------------ internals

  private useIndex(pages: TxtPage[], offset: number): void {
    pages.forEach((p, idx) => (p.pageNumber = idx + 1))
    this.allPages = pages
    this.currentIdx = indexByStart(pages, offset)
    this.current = pages[this.currentIdx] ?? null
    this.emit()
  }

  private startAt(targetOffset: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const clamped = Math.max(0, Math.min(targetOffset, Math.max(0, this.totalLength - 1)))
    const p = this.measurer.snapToLineStart(clamped)
    this.allPages = null
    this.pinStart = p
    this.pins = [p]
    this.bPages = []
    this.bCursor = { para: 0, char: 0 }
    this.bCursorAbs = 0
    this.detached = []
    this.fPages = []
    this.fCursor = this.measurer.posOf(p)
    this.fDone = false
    this.stepF(SYNC_WINDOW)
    this.current = this.fPages[0] ?? null
    this.checkReady()
    this.emit()
    this.schedule()
  }

  private addPin(offset: number): void {
    this.pins.push(offset)
    this.pins.sort((a, b) => a - b)
  }

  private stepB(windowSize: number): void {
    if (this.bCursorAbs >= this.pinStart) return
    const stop = this.pins.find((pin) => pin > this.bCursorAbs) ?? this.pinStart
    const res = this.measurer.step(this.bCursor, stop, windowSize)
    this.bPages.push(...res.pages)
    this.bCursor = res.next
    this.bCursorAbs = this.measurer.absOf(res.next)
    // Pages filled backward are identical to the chain's pages once it has reached them.
    while (this.detached.length && this.detached[0].startOffset < this.bCursorAbs) {
      this.detached.shift()
    }
  }

  private stepF(windowSize: number): void {
    if (this.fDone) return
    const res = this.measurer.step(this.fCursor, null, windowSize)
    this.fPages.push(...res.pages)
    this.fCursor = res.next
    if (res.atEnd) this.fDone = true
  }

  private checkReady(): void {
    if (this.allPages || this.bCursorAbs < this.pinStart || !this.fDone) return
    const pages = this.bPages.concat(this.fPages)
    pages.forEach((p, idx) => (p.pageNumber = idx + 1))
    if (pages.length) pages[pages.length - 1].percentage = 100
    this.allPages = pages
    const start = this.current?.startOffset ?? this.pinStart
    this.currentIdx = indexByStart(pages, start)
    this.current = pages[this.currentIdx] ?? null
    this.bPages = []
    this.fPages = []
    this.detached = []
  }

  private findByStart(start: number): TxtPage | null {
    return (
      findIn(this.bPages, start) ??
      this.detached.find((p) => p.startOffset === start) ??
      findIn(this.fPages, start)
    )
  }

  private findEndingAt(start: number): TxtPage | null {
    const list = [this.bPages, this.detached, this.fPages]
    for (const pages of list) {
      for (let k = pages.length - 1; k >= 0; k--) {
        const p = pages[k]
        if (p.startOffset < start && this.measurer.nextStartOf(p) === start) return p
        if (p.startOffset < start) break
      }
    }
    return null
  }

  private findContaining(offset: number): TxtPage | null {
    for (const pages of [this.bPages, this.detached, this.fPages]) {
      if (!pages.length) continue
      const idx = indexByStart(pages, offset)
      const p = pages[idx]
      if (p.startOffset <= offset && offset < this.measurer.nextStartOf(p)) return p
    }
    return null
  }

  private schedule(): void {
    if (this.timer || this.allPages || this.destroyed || !this.backgroundEnabled) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.destroyed || this.allPages) return
      const t0 = performance.now()
      if (this.bCursorAbs < this.pinStart) this.stepB(this.bgWindow)
      else if (!this.fDone) this.stepF(this.bgWindow)
      const elapsed = performance.now() - t0
      // Keep each background chunk around one frame.
      if (elapsed > 0) {
        this.bgWindow = Math.round(
          Math.max(20, Math.min(800, (this.bgWindow * BG_TICK_MS) / elapsed))
        )
      }
      this.checkReady()
      this.emit()
      this.schedule()
    }, 0)
  }

  private emit(): void {
    if (!this.destroyed) this.onChange(this.state)
  }
}

/** Distinct characters of a document (what the web fonts must cover). */
export function distinctChars(paragraphs: TxtParagraph[]): string {
  const seen = new Set<string>()
  for (const p of paragraphs) for (const ch of p.text) seen.add(ch)
  return Array.from(seen).join('')
}

/**
 * Loads, in one go, every web font file (unicode-range subset, e.g. of Noto Sans KR) needed to
 * render `chars` in `fontFamily`, for body text and bold headings. Pagination must measure with
 * the final fonts; otherwise each subset arriving later would change line breaks. Resolves with
 * whether any font face finished loading in the meantime (i.e. whether measurements may differ).
 */
export function preloadFontsForText(
  fontFamily: string,
  fontSizePx: number,
  chars: string
): Promise<boolean> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load || !chars) return Promise.resolve(false)
  const loadedCount = () => {
    let n = 0
    fonts.forEach((f) => {
      if (f.status === 'loaded') n++
    })
    return n
  }
  const before = loadedCount()
  const changed = () => loadedCount() > before
  return Promise.all([
    fonts.load(`${fontSizePx}px ${fontFamily}`, chars),
    fonts.load(`bold ${Math.round(fontSizePx * 1.15)}px ${fontFamily}`, chars)
  ]).then(changed, changed)
}

function findIn(pages: TxtPage[], start: number): TxtPage | null {
  if (!pages.length) return null
  const p = pages[indexByStart(pages, start)]
  return p && p.startOffset === start ? p : null
}

/** Index of the last page starting at or before `offset`. */
function indexByStart(pages: TxtPage[], offset: number): number {
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (pages[mid].startOffset <= offset) low = mid
    else high = mid - 1
  }
  return Math.max(0, low)
}
