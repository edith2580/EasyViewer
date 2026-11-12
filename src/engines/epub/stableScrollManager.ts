import ePub from 'epubjs'

/**
 * epub.js 'continuous' view manager with stable scroll positioning, used for EPUB scroll mode.
 *
 * The stock manager keeps the reading position by adding a newly inserted section's height to
 * scrollTop (`counter`). That breaks in two cases, both noticeable while scrolling up:
 *  - A section above the viewport changes height after it was inserted (typically when an image
 *    finishes loading later, which WebKit/iOS does), and nothing compensates for it.
 *  - On iOS, scrollTop changes made during a momentum fling are fought by the fling, so the view
 *    jumps.
 *
 * This manager instead:
 *  1. Anchors the reading position to the element at the top of the viewport and, after any view
 *     resizes, scrolls so that element stays exactly where it was.
 *  2. On iOS, waits until scrolling has settled before inserting sections above or trimming
 *     sections, and stops the fling when a correction must happen mid-scroll.
 */

const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** Scrolling counts as finished after this long without scroll/touch activity. */
const SCROLL_IDLE_MS = 180

interface ScrollAnchor {
  view: any
  /** Element inside the view's iframe document, or null to anchor on the view element itself. */
  node: Element | null
  /** Expected distance (px) from the scroll container's top edge to the anchor's top edge. */
  offset: number
}

let managerClass: any = null

export function getStableScrollManager(): any {
  if (managerClass) return managerClass

  // Resolve epub.js's own ContinuousViewManager (same module instance as the main bundle).
  const Base = (ePub as any).Rendition.prototype.requireManager('continuous')

  class StableScrollManager extends Base {
    private anchor: ScrollAnchor | null = null
    private lastKnownScrollTop = 0
    private lastUserActivityAt = 0
    private touchCount = 0
    private idleTimer: ReturnType<typeof setTimeout> | null = null
    private heldPrepend = false
    private heldTrim = false
    private savedOverflowY: string | null = null
    private flingStopTimer: ReturnType<typeof setTimeout> | null = null
    private touchStart = () => {
      this.touchCount++
      this.lastUserActivityAt = performance.now()
    }
    private touchEnd = () => {
      this.touchCount = Math.max(0, this.touchCount - 1)
      this.lastUserActivityAt = performance.now()
    }

    // ---------------------------------------------------------------- user activity

    private isUserScrolling(): boolean {
      const idleFor = performance.now() - this.lastUserActivityAt
      // A touch counts as active only while recent, in case a touchend was lost (e.g. the iframe
      // was destroyed mid-touch); a finger resting without moving for seconds isn't scrolling.
      return idleFor < SCROLL_IDLE_MS || (this.touchCount > 0 && idleFor < 4000)
    }

    /** Runs held prepend/trim work once the user has stopped scrolling. */
    private waitForIdle(): void {
      if (this.idleTimer) return
      const tick = () => {
        this.idleTimer = null
        if (!this.container) return
        if (this.isUserScrolling()) {
          this.idleTimer = setTimeout(tick, SCROLL_IDLE_MS)
          return
        }
        if (this.heldPrepend) {
          this.heldPrepend = false
          this.q.enqueue(() => this.check())
        }
        if (this.heldTrim) {
          this.heldTrim = false
          this.q.enqueue(() => this.trim())
        }
      }
      this.idleTimer = setTimeout(tick, SCROLL_IDLE_MS)
    }

    afterDisplayed(view: any): void {
      // Touches inside the content land in the iframe document, not the scroll container.
      const doc: Document | undefined = view?.document || view?.contents?.document
      if (doc) {
        doc.addEventListener('touchstart', this.touchStart, { passive: true })
        doc.addEventListener('touchend', this.touchEnd, { passive: true })
        doc.addEventListener('touchcancel', this.touchEnd, { passive: true })
      }
      super.afterDisplayed(view)
    }

    onScroll(): void {
      const programmatic = this.ignore
      super.onScroll()
      const scrollTop = this.container.scrollTop
      if (!programmatic) this.lastUserActivityAt = performance.now()
      // Track the anchor by the scroll delta instead of re-measuring it, so a layout shift that
      // hasn't been corrected yet is never baked into the anchor.
      if (this.anchor) this.anchor.offset -= scrollTop - this.lastKnownScrollTop
      this.lastKnownScrollTop = scrollTop
      if (!this.isAnchorUsable()) this.recordAnchor()
    }

    // ---------------------------------------------------------------- anchoring

    private containerTop(): number {
      return this.container.getBoundingClientRect().top
    }

    private measureAnchorTop(anchor: ScrollAnchor): number | null {
      const view = anchor.view
      if (!view?.element?.isConnected) return null
      if (!anchor.node) {
        return view.element.getBoundingClientRect().top - this.containerTop()
      }
      const frame: HTMLIFrameElement | undefined = view.iframe
      if (!frame || frame.contentDocument !== anchor.node.ownerDocument || !anchor.node.isConnected) {
        return null
      }
      return frame.getBoundingClientRect().top + anchor.node.getBoundingClientRect().top - this.containerTop()
    }

    private isAnchorUsable(): boolean {
      const a = this.anchor
      if (!a || !a.view?.element?.isConnected) return false
      if (a.node && (!a.view.iframe || a.view.iframe.contentDocument !== a.node.ownerDocument)) return false
      const h = this.container.clientHeight
      return a.offset > -h * 0.25 && a.offset < h * 0.6
    }

    /** Picks the element just below the top edge of the viewport as the new anchor. */
    private recordAnchor(): void {
      this.anchor = null
      const container: HTMLElement | undefined = this.container
      if (!container || !this.views) return
      const cTop = this.containerTop()
      const height = container.clientHeight
      this.lastKnownScrollTop = container.scrollTop

      for (const view of this.views.all()) {
        const el: HTMLElement | undefined = view.element
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.bottom <= cTop || r.top >= cTop + height) continue

        const frame: HTMLIFrameElement | undefined = view.iframe
        const doc = view.displayed && frame ? frame.contentDocument : null
        if (doc && frame) {
          const fRect = frame.getBoundingClientRect()
          // Probe a few points below the top edge for a real content element (not body/html).
          for (const dy of [8, 32, 64, 128]) {
            const y = Math.max(cTop, fRect.top) + dy - fRect.top
            if (y >= fRect.height) break
            for (const x of [fRect.width / 2, fRect.width / 4, (fRect.width * 3) / 4]) {
              const node = doc.elementFromPoint(x, y)
              if (node && node !== doc.body && node !== doc.documentElement) {
                this.anchor = {
                  view,
                  node,
                  offset: fRect.top + node.getBoundingClientRect().top - cTop
                }
                return
              }
            }
          }
        }
        this.anchor = { view, node: null, offset: r.top - cTop }
        return
      }
    }

    /** After any layout change, scroll so the anchor is back where the reader last saw it. */
    private restoreAnchor(): void {
      const a = this.anchor
      if (!a) return
      const top = this.measureAnchorTop(a)
      if (top === null) {
        this.recordAnchor()
        return
      }
      const diff = top - a.offset
      if (Math.abs(diff) >= 1) this.adjustScroll(diff)
    }

    private adjustScroll(dy: number): void {
      if (IS_IOS && this.isUserScrolling()) this.stopFling()
      this.scrollBy(0, dy, true)
    }

    /**
     * iOS keeps applying the momentum fling on top of a programmatic scrollTop change, which makes
     * the view jump. Briefly disabling overflow stops the fling so the correction sticks.
     * The original overflow value is saved only once: when several corrections land before the
     * restore runs, a later call must not save (and later restore) 'hidden', which used to leave
     * the container permanently unscrollable.
     */
    private stopFling(): void {
      const container: HTMLElement = this.container
      if (this.savedOverflowY === null) {
        this.savedOverflowY = container.style.overflowY
        container.style.overflowY = 'hidden'
      }
      if (this.flingStopTimer) clearTimeout(this.flingStopTimer)
      this.flingStopTimer = setTimeout(() => this.restoreOverflow(), 0)
    }

    private restoreOverflow(): void {
      if (this.flingStopTimer) clearTimeout(this.flingStopTimer)
      this.flingStopTimer = null
      if (this.savedOverflowY !== null && this.container) {
        this.container.style.overflowY = this.savedOverflowY
      }
      this.savedOverflowY = null
    }

    // ---------------------------------------------------------------- manager overrides

    createView(section: any, forceRight?: boolean): any {
      const view = super.createView(section, forceRight)
      view.on('resized', () => this.restoreAnchor())
      return view
    }

    /** Prepended views are compensated by restoreAnchor(); fall back to the stock behaviour only without an anchor. */
    counter(bounds: any): void {
      if (!this.anchor) super.counter(bounds)
    }

    scrollBy(x: number, y: number, silent?: boolean): void {
      super.scrollBy(x, y, silent)
      if (this.container) this.lastKnownScrollTop = this.container.scrollTop
    }

    scrollTo(x: number, y: number, silent?: boolean): void {
      super.scrollTo(x, y, silent)
      if (this.container) this.lastKnownScrollTop = this.container.scrollTop
    }

    moveTo(offset: any): void {
      super.moveTo(offset)
      this.recordAnchor()
    }

    clear(): void {
      this.anchor = null
      super.clear()
    }

    check(_offsetLeft?: number, _offsetTop?: number): Promise<any> {
      if (this.settings.axis === 'horizontal' || this.settings.fullsize || !this._bounds) {
        return super.check(_offsetLeft, _offsetTop)
      }

      const delta = _offsetTop || this.settings.offset || 0
      const container: HTMLElement = this.container
      const scrollTop = container.scrollTop
      const newViews: any[] = []

      if (scrollTop + this._bounds.height + delta >= container.scrollHeight) {
        const last = this.views.last()
        const next = last && last.section.next()
        if (next) newViews.push(this.append(next))
      }

      if (scrollTop - delta < 0) {
        const first = this.views.first()
        const prev = first && first.section.prev()
        if (prev) {
          if (IS_IOS && this.isUserScrolling()) {
            // Inserting above shifts scrollTop, which an active iOS fling can't absorb.
            this.heldPrepend = true
            this.waitForIdle()
          } else {
            newViews.push(this.prepend(prev))
          }
        }
      }

      if (newViews.length) {
        return Promise.all(newViews.map((view) => view.display(this.request)))
          .then(() => this.check())
          .then(
            () => this.update(delta),
            (err: unknown) => err
          )
      }

      this.q.enqueue(() => this.update())
      return Promise.resolve(false)
    }

    trim(): Promise<void> {
      if (IS_IOS && this.isUserScrolling()) {
        this.heldTrim = true
        this.waitForIdle()
        return Promise.resolve()
      }
      return super.trim()
    }

    destroy(): void {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = null
      this.restoreOverflow()
      this.anchor = null
      super.destroy()
    }
  }

  managerClass = StableScrollManager
  return managerClass
}
