declare module 'epubjs' {
  export interface NavItem {
    id: string
    href: string
    label: string
    subitems?: NavItem[]
    parent?: string
  }

  export interface Navigation {
    toc: NavItem[]
  }

  export interface PackagingMetadataObject {
    title: string
    creator: string
    description: string
    pubdate: string
    publisher: string
    identifier: string
    language: string
  }

  export interface LocationPoint {
    index: number
    href: string
    cfi: string
    displayed: {
      page: number
      total: number
    }
    location: number
    percentage: number
  }

  export interface RelocationLocation {
    start: LocationPoint
    end: LocationPoint
    atStart?: boolean
    atEnd?: boolean
  }

  export interface Themes {
    register(name: string, styles: Record<string, Record<string, string>>): void
    select(name: string): void
    fontSize(size: string): void
    font(fontFamily: string): void
    override(name: string, value: string, priority?: boolean): void
    default(styles: Record<string, Record<string, string>>): void
  }

  export interface Annotations {
    highlight(
      cfiRange: string,
      data?: Record<string, unknown>,
      cb?: (e: MouseEvent) => void,
      className?: string,
      styles?: Record<string, string>
    ): void
    remove(cfiRange: string, type?: string): void
  }

  export interface Rendition {
    display(target?: string | number): Promise<void>
    prev(): Promise<void>
    next(): Promise<void>
    destroy(): void
    resize(width?: number | string, height?: number | string): void
    flow(flow: 'paginated' | 'scrolled' | 'scrolled-doc'): void
    themes: Themes
    annotations: Annotations
    on(event: string, listener: (...args: any[]) => void): void
    off(event: string, listener: (...args: any[]) => void): void
    currentLocation(): RelocationLocation
    location?: RelocationLocation
    getContents(): any[]
  }

  export class EpubCFI {
    spinePos: number
    range: boolean
    constructor(cfiFrom?: string | Range | Node, base?: string | object, ignoreClass?: string)
    collapse(toStart?: boolean): void
    compare(cfiOne: string | EpubCFI, cfiTwo: string | EpubCFI): number
    isCfiString(str: string): boolean
    toString(): string
  }

  export interface SpineItem {
    index: number
    href: string
    cfiBase: string
    canonical: string
    load(request?: any): Promise<Element>
    unload(): void
    find(query: string): Array<{ cfi: string; excerpt: string }>
  }

  export interface Book {
    ready: Promise<any>
    load(url: string): Promise<any>
    loaded: {
      metadata: Promise<PackagingMetadataObject>
      navigation: Promise<Navigation>
      cover: Promise<string>
    }
    navigation: Navigation
    spine: {
      spineItems: SpineItem[]
      get(target?: string | number): SpineItem
    }
    locations: {
      generate(chars?: number): Promise<string[]>
      percentageFromCfi(cfi: string): number
      cfiFromPercentage(percent: number): string
      total: number
    }
    renderTo(element: HTMLElement | string, options?: Record<string, any>): Rendition
    coverUrl(): Promise<string | null>
    destroy(): void
  }

  export default function ePub(urlOrData?: string | ArrayBuffer | Blob, options?: Record<string, any>): Book
}
