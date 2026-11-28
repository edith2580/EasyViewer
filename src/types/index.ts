export type BookFormat = 'txt' | 'epub'

export type ViewMode = 'scroll' | 'paginated'

export type ThemeMode = 'light' | 'dark' | 'sepia'

export type FontFamilyOption = 'sans' | 'serif' | 'mono' | 'system'

export interface TxtTocPatternRule {
  id: string
  prefix: string
  suffix: string
  closing?: string
  enabled: boolean
}

export interface ViewerSettings {
  viewMode: ViewMode
  theme: ThemeMode
  fontFamily: FontFamilyOption
  fontSize: number // px (12 ~ 32)
  lineHeight: number // 1.2 ~ 2.4
  pageMargin: number // px (16 ~ 64)
  autoSync: boolean
  syncEndpoint: string
  txtTocRules?: TxtTocPatternRule[]
}

export interface ReadingLocation {
  bookId: string
  /** EPUB: CFI string, TXT: character offset or chunk:line string */
  locator: string
  /** 0 ~ 100 percentage */
  percentage: number
  /** Current chapter title or line preview */
  chapterTitle?: string
  /** Timestamp (ms) for sync conflict resolution */
  updatedAt: number
  /** Device identifier */
  deviceId: string
}

export interface BookmarkItem {
  id: string
  bookId: string
  locator: string
  percentage: number
  title: string
  excerpt: string
  createdAt: number
}

export interface TocItem {
  id: string
  label: string
  href: string
  subitems?: TocItem[]
  level?: number
}

export interface SearchResultItem {
  id: string
  locator: string
  excerpt: string
  chapterTitle?: string
  percentage?: number
  matchIndex?: number
}

export interface BookMeta {
  id: string
  title: string
  author: string
  format: BookFormat
  fileSize: number
  coverUrl?: string
  sourceUrl?: string
  /** Original file name, e.g. "윤동주 시선 - 별 헤는 밤.txt". */
  fileName?: string
  /** Desktop/mobile app: absolute path of the stored file (in the storage folder at import time). */
  storedPath?: string
  /** SHA-256 (hex) of the whole file; tells a re-import from a different book with a colliding id. */
  contentSha256?: string
  addedAt: number
  lastOpenedAt: number
  lastLocation?: ReadingLocation
}

export interface SyncPayload {
  version: number
  exportedAt: number
  deviceId: string
  positions: Record<string, ReadingLocation>
  bookmarks: Record<string, BookmarkItem[]>
  settings?: Partial<ViewerSettings>
}

export type CredentialScope = 'session' | 'native-secure' | 'web-acknowledged'

export interface WebDavConnection {
  id: string
  alias: string
  url: string
  username: string
  password?: string
  rememberPassword?: boolean
  credentialScope?: CredentialScope
  initialPath: string
  lastConnectedAt: number
}

export interface TrustedRemoteHostConsent {
  hostKey: string
  allowPrivateNetwork: boolean
  allowSelfSignedTls: boolean
  /** SHA-256 (hex) of the self-signed certificate the user approved; only it is accepted. */
  pinnedCertSha256?: string
  consentedAt: number
}

export interface PlatformCapabilities {
  canPickStorageDir: boolean
  canOpenStorageDir: boolean
  canDeleteLocalFile: boolean
  supportsNativeDragDrop: boolean
  hasSecureCredentialStore: boolean
}

export type PerformanceMetricName =
  | 'library_init_ms'
  | 'large_txt_open_ms'
  | 'view_mode_toggle_ms'
  | 'theme_switch_ms'

export interface PerformanceMetricSample {
  metric: PerformanceMetricName
  samplesMs: number[]
  medianMs: number
}

export interface PerformanceBaselineReport {
  capturedAt: string
  environment: string
  seededBookCount: number
  warmupRuns: number
  measuredRuns: number
  metrics: PerformanceMetricSample[]
}

export interface WebDavItem {
  name: string
  path: string
  href: string
  isDirectory: boolean
  size: number
  lastModified?: string
  format?: BookFormat
}


