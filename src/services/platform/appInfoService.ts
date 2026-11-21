import { remoteFetch } from '@/services/network/remoteFetch'
import { isDesktopApp, isTauriEnv } from '@/services/storage/platformAdapter'

declare const __APP_VERSION__: string | undefined

export const GITHUB_REPO_URL = 'https://github.com/edith2580/EasyViewer'
export const GITHUB_RELEASES_URL = 'https://github.com/edith2580/EasyViewer/releases'
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/edith2580/EasyViewer/releases/latest'

export type RuntimeOs = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
export type InstallMode = 'nsis' | 'msi' | 'portable' | 'standard'

export interface AppRuntimeInfo {
  name: string
  version: string
  description: string
  os: RuntimeOs
  osLabel: string
  installMode: InstallMode
  isDesktop: boolean
  isTauri: boolean
  supportsAutoUpdate: boolean
}

export interface ReleaseAssetInfo {
  name: string
  size: number
  downloadUrl: string
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  tagName: string
  releaseName: string
  publishedAt: string
  releaseUrl: string
  notes: string
  hasUpdate: boolean
  matchedAsset: ReleaseAssetInfo | null
  canAutoUpdate: boolean
}

export interface UsedLibraryItem {
  name: string
  version: string
  category: 'frontend' | 'runtime'
  purpose: string
  license: string
}

export const USED_LIBRARIES: UsedLibraryItem[] = [
  { name: 'Lucide Vue Next', version: '0.468', category: 'frontend', purpose: '벡터 아이콘 세트', license: 'ISC' },
  { name: 'epub.js', version: '0.3.93', category: 'frontend', purpose: 'EPUB 전자책 렌더링 엔진', license: 'BSD-2-Clause' },
  { name: 'JSZip', version: '3.10', category: 'frontend', purpose: 'EPUB 압축 해제 및 무결성 검사', license: 'MIT' },
  { name: 'reqwest & rustls', version: '0.13 / 0.23', category: 'runtime', purpose: 'Zero-Trust 원격 통신 및 TLS 검증', license: 'MIT / Apache-2.0' }
]

const OS_LABELS: Record<RuntimeOs, string> = {
  windows: 'Windows (Desktop)',
  macos: 'macOS (Desktop)',
  linux: 'Linux (Desktop)',
  android: 'Android',
  ios: 'iOS',
  web: 'Web Browser'
}

export function getBundledAppVersion(): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()
    ? __APP_VERSION__.trim()
    : '0.2.4'
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => {
        const parsed = parseInt(n, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })

  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length, 3)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  return 0
}

function detectWebOsFallback(): RuntimeOs {
  if (typeof navigator === 'undefined') return 'web'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('android')) return 'android'
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios'
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('linux')) return 'linux'
  return 'web'
}

export async function getAppRuntimeInfo(): Promise<AppRuntimeInfo> {
  const tauri = isTauriEnv()
  const desktop = await isDesktopApp()
  let version = getBundledAppVersion()
  let os: RuntimeOs = tauri ? detectWebOsFallback() : 'web'
  let installMode: InstallMode = 'standard'

  if (tauri) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      const nativeVer = await getVersion()
      if (nativeVer) version = nativeVer
    } catch {
      // Fallback to bundled package.json version
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const nativeOs = (await invoke<string>('get_platform_os')).toLowerCase()
      if (
        nativeOs === 'windows' ||
        nativeOs === 'macos' ||
        nativeOs === 'linux' ||
        nativeOs === 'android' ||
        nativeOs === 'ios'
      ) {
        os = nativeOs
      }
      const mode = (await invoke<string>('get_install_mode')).toLowerCase()
      if (mode === 'nsis' || mode === 'msi' || mode === 'portable' || mode === 'standard') {
        installMode = mode
      }
    } catch {
      // Fallback to UA detection
    }
  }

  let osLabel = OS_LABELS[os]
  if (os === 'windows' && tauri) {
    if (installMode === 'portable') osLabel = 'Windows (포터블)'
    else if (installMode === 'nsis') osLabel = 'Windows (설치 버전 · NSIS)'
    else if (installMode === 'msi') osLabel = 'Windows (설치 버전 · MSI)'
  }

  return {
    name: 'EasyViewer',
    version,
    description: '심플한 Text · EPUB 범용 문서 뷰어',
    os,
    osLabel,
    installMode,
    isDesktop: desktop,
    isTauri: tauri,
    supportsAutoUpdate: tauri && desktop && (os === 'windows' || os === 'macos' || os === 'linux')
  }
}

export function selectAssetForOs(
  assets: ReleaseAssetInfo[],
  os: RuntimeOs,
  installMode: InstallMode = 'standard'
): ReleaseAssetInfo | null {
  const findBy = (pred: (lowerName: string) => boolean) =>
    assets.find((a) => pred(a.name.toLowerCase())) || null

  if (os === 'windows') {
    if (installMode === 'portable') {
      return findBy((n) => n.includes('portable') && n.endsWith('.zip')) || findBy((n) => n.endsWith('.zip'))
    }
    if (installMode === 'msi') {
      return findBy((n) => n.endsWith('.msi')) || findBy((n) => n.endsWith('-setup.exe'))
    }
    return (
      findBy((n) => n.endsWith('-setup.exe')) ||
      findBy((n) => n.endsWith('.exe')) ||
      findBy((n) => n.endsWith('.msi'))
    )
  }
  if (os === 'macos') {
    return findBy((n) => n.endsWith('.dmg'))
  }
  if (os === 'linux') {
    return (
      findBy((n) => n.endsWith('.appimage')) ||
      findBy((n) => n.endsWith('.deb')) ||
      findBy((n) => n.endsWith('.rpm'))
    )
  }
  if (os === 'android') {
    return findBy((n) => n.endsWith('.apk'))
  }
  return null
}

interface GitHubReleaseApiResponse {
  tag_name?: string
  name?: string
  published_at?: string
  html_url?: string
  body?: string
  assets?: Array<{
    name?: string
    size?: number
    browser_download_url?: string
  }>
}

export async function checkLatestRelease(info: AppRuntimeInfo): Promise<UpdateCheckResult> {
  const res = await remoteFetch(GITHUB_LATEST_RELEASE_API, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `EasyViewer/${info.version}`
    },
    timeoutMs: 15_000
  })

  if (!res.ok) {
    throw new Error(`GitHub 릴리즈 정보를 불러오지 못했습니다 (HTTP ${res.status})`)
  }

  const data = (await res.json()) as GitHubReleaseApiResponse
  const tagName = (data.tag_name || '').trim()
  const latestVersion = tagName.replace(/^v/i, '') || info.version
  const assets: ReleaseAssetInfo[] = (data.assets || [])
    .filter((a) => a.name && a.browser_download_url)
    .map((a) => ({
      name: String(a.name),
      size: Number(a.size || 0),
      downloadUrl: String(a.browser_download_url)
    }))

  const hasUpdate = compareSemver(latestVersion, info.version) > 0
  const matchedAsset = selectAssetForOs(assets, info.os, info.installMode)

  return {
    currentVersion: info.version,
    latestVersion,
    tagName: tagName || `v${latestVersion}`,
    releaseName: (data.name || tagName || `v${latestVersion}`).trim(),
    publishedAt: data.published_at || '',
    releaseUrl: data.html_url || GITHUB_RELEASES_URL,
    notes: (data.body || '').trim(),
    hasUpdate,
    matchedAsset,
    canAutoUpdate: Boolean(hasUpdate && info.supportsAutoUpdate && matchedAsset)
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriEnv()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function installAutoUpdate(asset: ReleaseAssetInfo): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('install_release_update', {
    downloadUrl: asset.downloadUrl,
    assetName: asset.name
  })
}
