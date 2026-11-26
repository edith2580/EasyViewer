import type { TrustedRemoteHostConsent } from '@/types'
import { validateRemoteUrlSyntax } from '@/services/network/ssrfValidator'
import { isTauriEnv, platformStorage } from '@/services/storage/platformAdapter'

const HOST_CONSENT_STORAGE_KEY = 'trusted_remote_host_consents_v1'
export const MAX_REMOTE_RESPONSE_BYTES = 256 * 1024 * 1024

export type RemoteFetchErrorCode =
  | 'BLOCKED_HIGH_RISK'
  | 'PRIVATE_NETWORK_CONFIRM_REQUIRED'
  | 'SELF_SIGNED_TLS_CONFIRM_REQUIRED'
  | 'NETWORK_ERROR'

export class RemoteFetchConsentError extends Error {
  readonly code: RemoteFetchErrorCode
  readonly origin: string
  /** SHA-256 of the certificate the server presented (self-signed TLS prompts). */
  readonly certFingerprint?: string
  /** True when the server's certificate differs from the one approved earlier. */
  readonly certChanged?: boolean

  constructor(
    code: RemoteFetchErrorCode,
    origin: string,
    message: string,
    tls?: { certFingerprint?: string; certChanged?: boolean }
  ) {
    super(message)
    this.name = 'RemoteFetchConsentError'
    this.code = code
    this.origin = origin
    this.certFingerprint = tls?.certFingerprint
    this.certChanged = tls?.certChanged
  }
}

/**
 * Certificate fingerprints the native side reported for origins awaiting a self-signed TLS
 * decision. Approving the prompt pins exactly this certificate (trust on first use); a different
 * certificate later triggers a new prompt instead of being accepted silently.
 */
const pendingTlsFingerprints = new Map<string, string>()

/** `ab12cd…` → `AB12 CD34 …` for display. */
export function formatCertFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,4}/g) || []).join(' ')
}

/** Prompt text for a self-signed TLS decision, including the certificate to be trusted. */
export function describeTlsConsent(prompt: {
  origin: string
  fingerprint?: string
  certChanged?: boolean
}): string {
  const fp = prompt.fingerprint
    ? ` 인증서 SHA-256: ${formatCertFingerprint(prompt.fingerprint)}`
    : ''
  if (prompt.certChanged) {
    return `주의: ${prompt.origin} 서버의 인증서가 이전에 신뢰한 인증서와 다릅니다. 서버 인증서를 직접 바꾼 경우가 아니라면 중간자 공격일 수 있습니다. 새 인증서를 신뢰하시겠습니까?${fp}`
  }
  return `자체 서명 TLS 인증서(${prompt.origin}) 예외를 허용하시겠습니까? 이 인증서만 신뢰하며, 인증서가 바뀌면 다시 확인합니다.${fp}`
}

export function parseTlsDetails(message: string): { certFingerprint?: string; certChanged: boolean } {
  const match = /\[cert-sha256:([0-9a-f]{64})\]/i.exec(message)
  return {
    certFingerprint: match ? match[1].toLowerCase() : undefined,
    certChanged: message.includes('[cert-changed]')
  }
}

export interface RemoteFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array
  allowPrivateNas?: boolean
  allowSelfSignedTls?: boolean
  /** Refuse plain http:// to public-internet servers (e.g. sync payloads). */
  forbidPlaintextPublic?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
}

interface RustSafeRemoteFetchMeta {
  status: number
  statusText: string
  headers: Record<string, string>
  finalUrl: string
}

function toUint8Array(raw: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (raw instanceof ArrayBuffer || Object.prototype.toString.call(raw) === '[object ArrayBuffer]') {
    return new Uint8Array(raw as ArrayBuffer)
  }
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return Uint8Array.from(raw as number[])
}

/**
 * Decodes the native `safe_remote_fetch` binary response:
 * `[u32 big-endian metadata length][metadata JSON][raw body]`.
 */
export function decodeNativeFetchResponse(raw: ArrayBuffer | ArrayBufferView | number[]): {
  meta: RustSafeRemoteFetchMeta
  body: ArrayBuffer
} {
  const bytes = toUint8Array(raw)
  if (bytes.byteLength < 4) throw new Error('원격 응답 형식이 올바르지 않습니다.')
  const metaLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  if (4 + metaLen > bytes.byteLength) throw new Error('원격 응답 형식이 올바르지 않습니다.')
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLen))
  ) as RustSafeRemoteFetchMeta
  const bodyView = bytes.subarray(4 + metaLen)
  const body = bodyView.buffer.slice(
    bodyView.byteOffset,
    bodyView.byteOffset + bodyView.byteLength
  ) as ArrayBuffer
  return { meta, body }
}

function getProxySessionToken(): string {
  if (typeof document === 'undefined') return ''
  return document.querySelector('meta[name="ev-proxy-token"]')?.getAttribute('content') || ''
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function loadHostConsents(): Promise<TrustedRemoteHostConsent[]> {
  const list = await platformStorage.getItem<TrustedRemoteHostConsent[]>(
    HOST_CONSENT_STORAGE_KEY,
    []
  )
  return Array.isArray(list) ? list : []
}

export async function getHostConsent(targetUrl: string): Promise<TrustedRemoteHostConsent | null> {
  try {
    const hostKey = new URL(targetUrl).origin
    const list = await loadHostConsents()
    return list.find((item) => item.hostKey === hostKey) ?? null
  } catch {
    return null
  }
}

export async function grantHostConsent(
  targetUrl: string,
  patch: Partial<
    Pick<TrustedRemoteHostConsent, 'allowPrivateNetwork' | 'allowSelfSignedTls' | 'pinnedCertSha256'>
  >
): Promise<TrustedRemoteHostConsent> {
  const hostKey = new URL(targetUrl).origin
  const list = await loadHostConsents()
  const idx = list.findIndex((item) => item.hostKey === hostKey)
  const prev = idx >= 0 ? list[idx] : null
  // Approving a self-signed certificate pins the exact certificate shown in the prompt.
  const pinnedCertSha256 = patch.allowSelfSignedTls
    ? (patch.pinnedCertSha256 ?? pendingTlsFingerprints.get(hostKey) ?? prev?.pinnedCertSha256)
    : prev?.pinnedCertSha256
  if (patch.allowSelfSignedTls) pendingTlsFingerprints.delete(hostKey)
  const updated: TrustedRemoteHostConsent = {
    hostKey,
    allowPrivateNetwork: patch.allowPrivateNetwork ?? prev?.allowPrivateNetwork ?? false,
    allowSelfSignedTls: patch.allowSelfSignedTls ?? prev?.allowSelfSignedTls ?? false,
    ...(pinnedCertSha256 ? { pinnedCertSha256 } : {}),
    consentedAt: Date.now()
  }
  if (idx >= 0) {
    list[idx] = updated
  } else {
    list.unshift(updated)
  }
  await platformStorage.setItem(HOST_CONSENT_STORAGE_KEY, list.slice(0, 50))
  return updated
}

function encodeBodyToBase64(body?: string | ArrayBuffer | Uint8Array): string | undefined {
  if (body === undefined) return undefined
  if (typeof body === 'string') {
    return bytesToBase64(new TextEncoder().encode(body))
  }
  if (body instanceof Uint8Array) {
    return bytesToBase64(body)
  }
  return bytesToBase64(new Uint8Array(body))
}

function mapErrorPrefixToCode(message: string): RemoteFetchErrorCode | null {
  if (message.startsWith('BLOCKED_HIGH_RISK:')) return 'BLOCKED_HIGH_RISK'
  if (message.startsWith('PRIVATE_NETWORK_CONFIRM_REQUIRED:')) {
    return 'PRIVATE_NETWORK_CONFIRM_REQUIRED'
  }
  if (message.startsWith('SELF_SIGNED_TLS_CONFIRM_REQUIRED:')) {
    return 'SELF_SIGNED_TLS_CONFIRM_REQUIRED'
  }
  return null
}

/**
 * Unified Zero-Trust remote HTTP/HTTPS client routing Tauri to Rust `safe_remote_fetch`
 * and Browser builds through `/__remote_proxy` with host-level exception consent checks.
 */
export async function remoteFetch(url: string, options: RemoteFetchOptions = {}): Promise<Response> {
  const validated = validateRemoteUrlSyntax(url)
  const origin = validated.url.origin

  if (validated.classification === 'blocked-high-risk') {
    throw new RemoteFetchConsentError(
      'BLOCKED_HIGH_RISK',
      origin,
      '보안 정책에 의해 차단된 내부 네트워크 주소입니다.'
    )
  }

  const storedConsent = await getHostConsent(url)
  const allowPrivateNas = options.allowPrivateNas ?? Boolean(storedConsent?.allowPrivateNetwork)
  const allowSelfSignedTls = options.allowSelfSignedTls ?? Boolean(storedConsent?.allowSelfSignedTls)

  if (validated.classification === 'private-network' && !allowPrivateNas) {
    throw new RemoteFetchConsentError(
      'PRIVATE_NETWORK_CONFIRM_REQUIRED',
      origin,
      `사설 네트워크(${validated.hostname}) 접근에는 사용자 승인이 필요합니다.`
    )
  }

  const method = (options.method || 'GET').toUpperCase()
  const maxResponseBytes = Math.min(
    options.maxResponseBytes ?? MAX_REMOTE_RESPONSE_BYTES,
    MAX_REMOTE_RESPONSE_BYTES
  )

  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      const raw = await invoke<ArrayBuffer | ArrayBufferView | number[]>('safe_remote_fetch', {
        request: {
          url: validated.url.toString(),
          method,
          headers: options.headers ?? {},
          bodyBase64: encodeBodyToBase64(options.body),
          allowPrivateNas,
          allowSelfSignedTls,
          pinnedCertSha256: allowSelfSignedTls ? storedConsent?.pinnedCertSha256 : undefined,
          forbidPlaintextPublic: options.forbidPlaintextPublic ?? false,
          timeoutMs: options.timeoutMs,
          maxResponseBytes
        }
      })
      const { meta, body } = decodeNativeFetchResponse(raw)
      // Response() rejects a body for null-body statuses (204/205/304).
      const nullBody = meta.status === 204 || meta.status === 205 || meta.status === 304
      return new Response(nullBody ? null : body, {
        status: meta.status,
        statusText: meta.statusText,
        headers: new Headers(meta.headers)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = mapErrorPrefixToCode(msg)
      if (code) {
        const tls = code === 'SELF_SIGNED_TLS_CONFIRM_REQUIRED' ? parseTlsDetails(msg) : undefined
        if (tls?.certFingerprint) pendingTlsFingerprints.set(origin, tls.certFingerprint)
        const cleanMsg = msg
          .replace(/^[A-Z0-9_]+:\s*/, '')
          .replace(/\s*\[cert-sha256:[0-9a-f]{64}\]/i, '')
          .replace(/\s*\[cert-changed\]/, '')
        throw new RemoteFetchConsentError(code, origin, cleanMsg, tls)
      }
      throw new Error(msg.replace(/^INSECURE_HTTP_BLOCKED:\s*/, ''))
    }
  }

  // Web build: same rule the native side enforces on resolved IPs — no credentials or sync data
  // over plain HTTP to an internet host.
  const hasAuthHeader = Object.keys(options.headers ?? {}).some((k) => k.toLowerCase() === 'authorization')
  if (
    validated.url.protocol === 'http:' &&
    validated.classification === 'public' &&
    (options.forbidPlaintextPublic || hasAuthHeader)
  ) {
    throw new Error(
      '암호화되지 않은 HTTP로 인터넷의 서버에 비밀번호나 동기화 데이터를 보낼 수 없습니다. HTTPS 주소를 사용해 주세요.'
    )
  }

  const proxyHeaders: Record<string, string> = {
    'x-target-url': validated.url.toString(),
    'x-target-method': method,
    'x-max-response-bytes': String(maxResponseBytes)
  }
  if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    proxyHeaders['x-request-timeout-ms'] = String(
      Math.min(120_000, Math.max(1_000, Math.floor(options.timeoutMs)))
    )
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

  const token = getProxySessionToken()
  if ((allowPrivateNas || allowSelfSignedTls) && token) {
    proxyHeaders['x-proxy-session-token'] = token
  }
  if (allowPrivateNas) {
    proxyHeaders['x-allow-private-nas'] = '1'
  }
  if (allowSelfSignedTls) {
    proxyHeaders['x-allow-insecure-tls'] = '1'
  }

  const proxyBody =
    typeof options.body === 'string'
      ? options.body
      : options.body instanceof Uint8Array
        ? options.body.buffer.slice(
            options.body.byteOffset,
            options.body.byteOffset + options.body.byteLength
          ) as ArrayBuffer
        : options.body

  const proxyRes = await fetch('/__remote_proxy', {
    method: proxyBody ? 'POST' : 'GET',
    headers: proxyHeaders,
    body: proxyBody
  })

  const isProxyHandled = proxyRes.headers.get('x-easyviewer-proxy') === '1'
  if (proxyRes.status !== 404 || isProxyHandled) {
    if (proxyRes.status === 403 || proxyRes.status === 502) {
      let jsonErr: { code?: string; error?: string } | null = null
      const cloneText = await proxyRes.clone().text().catch(() => '')
      try {
        jsonErr = JSON.parse(cloneText) as { code?: string; error?: string }
      } catch {
        jsonErr = null
      }
      if (
        jsonErr?.code === 'PRIVATE_NETWORK_CONFIRM_REQUIRED' ||
        jsonErr?.code === 'SELF_SIGNED_TLS_CONFIRM_REQUIRED' ||
        jsonErr?.code === 'BLOCKED_HIGH_RISK'
      ) {
        throw new RemoteFetchConsentError(
          jsonErr.code,
          origin,
          jsonErr.error || '원격 서버 보안 확인이 필요합니다.'
        )
      }
      if (proxyRes.status === 502) {
        throw new Error(jsonErr?.error || cloneText || '원격 서버에 연결할 수 없습니다.')
      }
    }
    return proxyRes
  }

  // Static production web hosting without proxy middleware cannot bypass CORS/private IPs;
  // only allow public HTTPS/HTTP direct fetch when proxy endpoint itself is absent (404).
  if (validated.classification !== 'public') {
    throw new RemoteFetchConsentError(
      'PRIVATE_NETWORK_CONFIRM_REQUIRED',
      origin,
      '브라우저 환경에서는 보안 프록시 없이 사설 네트워크 주소에 직접 연결할 수 없습니다.'
    )
  }

  return fetch(validated.url.toString(), {
    method,
    headers: options.headers,
    body: proxyBody
  })
}
