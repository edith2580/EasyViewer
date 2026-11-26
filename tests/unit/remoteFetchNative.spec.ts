import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import {
  decodeNativeFetchResponse,
  describeTlsConsent,
  grantHostConsent,
  loadHostConsents,
  RemoteFetchConsentError,
  remoteFetch
} from '@/services/network/remoteFetch'

/** Builds the native `[u32 BE meta length][meta JSON][body]` response. */
function encodeNative(meta: object, body: Uint8Array): ArrayBuffer {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + metaBytes.length + body.length)
  new DataView(out.buffer).setUint32(0, metaBytes.length, false)
  out.set(metaBytes, 4)
  out.set(body, 4 + metaBytes.length)
  return out.buffer
}

const FP = 'ab'.repeat(32)

describe('remoteFetch native bridge: binary responses and pinned self-signed TLS', () => {
  afterEach(() => {
    clearMocks()
    vi.restoreAllMocks()
  })

  it('decodes the binary response without base64 and keeps raw bytes intact', () => {
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])
    const { meta, body: out } = decodeNativeFetchResponse(
      encodeNative({ status: 200, statusText: 'OK', headers: { 'content-type': 'application/epub+zip' }, finalUrl: 'https://x/a.epub' }, body)
    )
    expect(meta.status).toBe(200)
    expect(Array.from(new Uint8Array(out))).toEqual(Array.from(body))
    expect(() => decodeNativeFetchResponse(new Uint8Array([0, 0, 0, 99, 1]).buffer)).toThrow()
  })

  it('pins exactly the presented certificate when the user approves a self-signed prompt', async () => {
    const requests: Array<Record<string, unknown>> = []
    let approved = false
    mockIPC((cmd, payload) => {
      if (cmd !== 'safe_remote_fetch') return null
      const req = (payload as { request: Record<string, unknown> }).request
      requests.push(req)
      if (!approved) {
        throw `SELF_SIGNED_TLS_CONFIRM_REQUIRED: TLS 인증서 검증에 실패했습니다 [cert-sha256:${FP}]`
      }
      return encodeNative({ status: 207, statusText: 'Multi-Status', headers: {}, finalUrl: req.url as string }, new TextEncoder().encode('<ok/>'))
    })

    const url = 'https://nas-pin-test.example.com:5006/books/'
    const err = await remoteFetch(url, { method: 'PROPFIND' }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteFetchConsentError)
    expect(err.code).toBe('SELF_SIGNED_TLS_CONFIRM_REQUIRED')
    expect(err.certFingerprint).toBe(FP)
    expect(err.certChanged).toBe(false)
    expect(err.message).not.toContain('[cert-sha256')
    expect(describeTlsConsent({ origin: err.origin, fingerprint: err.certFingerprint })).toContain('ABAB ABAB')

    await grantHostConsent(url, { allowSelfSignedTls: true })
    const stored = (await loadHostConsents()).find((c) => c.hostKey === 'https://nas-pin-test.example.com:5006')
    expect(stored?.pinnedCertSha256).toBe(FP)

    approved = true
    const res = await remoteFetch(url, { method: 'PROPFIND' })
    expect(res.status).toBe(207)
    expect(await res.text()).toBe('<ok/>')
    expect(requests[1].allowSelfSignedTls).toBe(true)
    expect(requests[1].pinnedCertSha256).toBe(FP)
  })

  it('flags a changed certificate so the prompt warns about a possible man-in-the-middle', async () => {
    mockIPC((cmd) => {
      if (cmd === 'safe_remote_fetch') {
        throw `SELF_SIGNED_TLS_CONFIRM_REQUIRED: 이전에 신뢰한 인증서와 다른 인증서가 제시되었습니다 [cert-sha256:${'cd'.repeat(32)}] [cert-changed]`
      }
      return null
    })
    const err = await remoteFetch('https://nas-changed.example.com/').catch((e) => e)
    expect(err.certChanged).toBe(true)
    expect(describeTlsConsent({ origin: err.origin, fingerprint: err.certFingerprint, certChanged: true })).toContain('중간자 공격')
  })

  it('refuses credentials or sync data over plain HTTP to an internet host on the web path', async () => {
    await expect(
      remoteFetch('http://sync.example.com/payload', { forbidPlaintextPublic: true })
    ).rejects.toThrow(/HTTPS/)
    await expect(
      remoteFetch('http://dav.example.com/', { headers: { Authorization: 'Basic eDp5' } })
    ).rejects.toThrow(/HTTPS/)
  })
})
