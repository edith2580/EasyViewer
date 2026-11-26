import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRemoteProxyHandler } from '../../scripts/remoteProxyGuard.mjs'

describe('/__remote_proxy Zero-Trust security middleware (US3 - TDD)', () => {
  let upstreamServer: http.Server
  let upstreamPort = 0
  let httpsUpstreamServer: https.Server
  let httpsUpstreamPort = 0
  let proxyServer: http.Server
  let proxyPort = 0
  let deadlineProxyServer: http.Server
  let deadlineProxyPort = 0
  let certTmpDir = ''
  const sessionToken = 'test-ephemeral-proxy-token'

  beforeAll(async () => {
    upstreamServer = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1')
      if (parsed.pathname === '/redirect-loopback') {
        res.statusCode = 302
        res.setHeader('Location', 'http://127.0.0.1:9/secret')
        res.end()
        return
      }
      if (parsed.pathname === '/redirect-cross-origin') {
        res.statusCode = 302
        res.setHeader('Location', `http://public-other.example:${upstreamPort}/cross-target`)
        res.end()
        return
      }
      if (parsed.pathname === '/cross-target') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            auth: req.headers.authorization ?? null,
            cookie: req.headers.cookie ?? null
          })
        )
        return
      }
      if (parsed.pathname === '/redirect-hop') {
        const hop = Number(parsed.searchParams.get('hop') || '0')
        res.statusCode = 302
        res.setHeader('Location', `/redirect-hop?hop=${hop + 1}`)
        res.end()
        return
      }
      if (parsed.pathname === '/upstream-404') {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('missing-upstream-resource')
        return
      }
      if (parsed.pathname === '/large-declared') {
        const payload = 'A'.repeat(4096)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', String(Buffer.byteLength(payload)))
        res.end(payload)
        return
      }
      if (parsed.pathname === '/large-stream') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        for (let i = 0; i < 6; i += 1) {
          res.write('B'.repeat(512))
        }
        res.end()
        return
      }
      if (parsed.pathname === '/slow-stream') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.write('start-')
        let count = 0
        const timer = setInterval(() => {
          count += 1
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer)
            return
          }
          res.write(`chunk-${count}-`)
          if (count >= 8) {
            clearInterval(timer)
            res.end('done')
          }
        }, 40)
        res.on('close', () => clearInterval(timer))
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok-from-upstream')
    })

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (upstreamServer.address() as { port: number }).port
        resolve()
      })
    })

    certTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-proxy-cert-'))
    const keyPath = path.join(certTmpDir, 'key.pem')
    const certPath = path.join(certTmpDir, 'cert.pem')
    const opensslCandidates =
      process.platform === 'win32'
        ? [
            'openssl',
            'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
            'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
            'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe'
          ]
        : ['openssl']
    const opensslBin =
      opensslCandidates.find((bin) => bin !== 'openssl' && fs.existsSync(bin)) || 'openssl'
    execFileSync(
      opensslBin,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=private-nas.local'
      ],
      { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
    )
    httpsUpstreamServer = https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      },
      (_req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.end('ok-from-self-signed-https')
      }
    )
    await new Promise<void>((resolve) => {
      httpsUpstreamServer.listen(0, '127.0.0.1', () => {
        httpsUpstreamPort = (httpsUpstreamServer.address() as { port: number }).port
        resolve()
      })
    })

    const dnsOverride = async (hostname: string) => {
      if (hostname === 'private-nas.local') {
        return [{ address: '127.0.0.1', family: 4, simulatedClassification: 'private-network' }]
      }
      if (hostname === 'public-other.example') {
        return [{ address: '127.0.0.1', family: 4, simulatedClassification: 'public' }]
      }
      return [{ address: '127.0.0.1', family: 4, simulatedClassification: 'blocked-high-risk' }]
    }

    const handler = createRemoteProxyHandler({
      sessionToken,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 2048,
      timeoutMs: 2000,
      testDnsOverride: dnsOverride
    })

    proxyServer = http.createServer((req, res) => {
      handler(req, res, () => {
        res.statusCode = 404
        res.end('not handled')
      })
    })

    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        proxyPort = (proxyServer.address() as { port: number }).port
        resolve()
      })
    })

    const deadlineHandler = createRemoteProxyHandler({
      sessionToken,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 2048,
      timeoutMs: 120,
      testDnsOverride: dnsOverride
    })
    deadlineProxyServer = http.createServer((req, res) => {
      deadlineHandler(req, res, () => {
        res.statusCode = 404
        res.end('not handled')
      })
    })
    await new Promise<void>((resolve) => {
      deadlineProxyServer.listen(0, '127.0.0.1', () => {
        deadlineProxyPort = (deadlineProxyServer.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    const closeServer = (server?: http.Server | https.Server) =>
      server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()
    await closeServer(deadlineProxyServer)
    await closeServer(proxyServer)
    await closeServer(httpsUpstreamServer)
    await closeServer(upstreamServer)
    if (certTmpDir) {
      fs.rmSync(certTmpDir, { recursive: true, force: true })
    }
  })

  it('rejects requests with missing or mismatching Origin/Sec-Fetch-Site (Fail-Closed 403) and never emits wildcard CORS', async () => {
    const noOrigin = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: { 'x-target-url': 'https://example.com/book.txt' }
    })
    expect(noOrigin.status).toBe(403)
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull()

    const badOrigin = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: 'https://evil.attacker.example',
        'x-target-url': 'https://example.com/book.txt'
      }
    })
    expect(badOrigin.status).toBe(403)

    const badFetchSite = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'Sec-Fetch-Site': 'cross-site',
        'x-target-url': 'https://example.com/book.txt'
      }
    })
    expect(badFetchSite.status).toBe(403)
  })

  it('rejects DNS-rebinding Host names even when Origin matches the Host (403 FORBIDDEN_HOST)', async () => {
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path: '/__remote_proxy',
          method: 'GET',
          headers: {
            Host: `attacker.example:${proxyPort}`,
            Origin: `http://attacker.example:${proxyPort}`,
            'Sec-Fetch-Site': 'same-origin',
            'x-target-url': 'https://example.com/book.txt'
          }
        },
        (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode || 0, body }))
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body).code).toBe('FORBIDDEN_HOST')

    const { isAllowedProxyHost } = await import('../../scripts/remoteProxyGuard.mjs')
    expect(isAllowedProxyHost('localhost:1420')).toBe(true)
    expect(isAllowedProxyHost('127.0.0.1:1420')).toBe(true)
    expect(isAllowedProxyHost('[::1]:1420')).toBe(true)
    expect(isAllowedProxyHost('192.168.0.20:1420')).toBe(true)
    expect(isAllowedProxyHost('attacker.example:1420')).toBe(false)
    expect(isAllowedProxyHost('dev.example.test:1420', ['dev.example.test'])).toBe(true)
    expect(isAllowedProxyHost('a.dev.example.test', ['.dev.example.test'])).toBe(true)
    expect(isAllowedProxyHost(undefined)).toBe(false)
  })

  it('enforces method allowlist and request body size cap', async () => {
    const badMethod = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'DELETE',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-target-url': 'https://example.com/book.txt'
      }
    })
    expect(badMethod.status).toBe(405)

    const oversizedBody = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-target-url': 'https://example.com/book.txt'
      },
      body: 'A'.repeat(2048)
    })
    expect(oversizedBody.status).toBe(413)
  })

  it('requires valid session token alongside x-allow-private-nas and always blocks loopback/metadata targets', async () => {
    const spoofedPrivate = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-target-url': `http://private-nas.local:${upstreamPort}/book.txt`,
        'x-allow-private-nas': '1'
      }
    })
    expect(spoofedPrivate.status).toBe(403)

    const noConsentPrivate = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-target-url': `http://private-nas.local:${upstreamPort}/book.txt`
      }
    })
    expect(noConsentPrivate.status).toBe(403)
    const body = (await noConsentPrivate.json()) as { code?: string }
    expect(body.code).toBe('PRIVATE_NETWORK_CONFIRM_REQUIRED')

    const consentedPrivate = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/book.txt`
      }
    })
    expect(consentedPrivate.status).toBe(200)
    expect(await consentedPrivate.text()).toBe('ok-from-upstream')

    // Loopback target cannot be bypassed even with session token + x-allow-private-nas
    const loopbackBypass = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://127.0.0.1:${upstreamPort}/book.txt`
      }
    })
    expect(loopbackBypass.status).toBe(403)
    expect(loopbackBypass.headers.get('x-easyviewer-proxy')).toBe('1')
  })

  it('validates Referer same-origin when Origin header is omitted', async () => {
    const validReferer = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Referer: `http://127.0.0.1:${proxyPort}/library`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/book.txt`
      }
    })
    expect(validReferer.status).toBe(200)
    expect(validReferer.headers.get('x-easyviewer-proxy')).toBe('1')

    const crossReferer = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Referer: 'https://evil.attacker.example/page',
        'x-target-url': `http://public-other.example:${upstreamPort}/book.txt`
      }
    })
    expect(crossReferer.status).toBe(403)
    expect(crossReferer.headers.get('x-easyviewer-proxy')).toBe('1')
  })

  it('blocks /redirect-loopback (403), enforces >5 redirects cap (508), and strips Authorization/Cookie on /redirect-cross-origin', async () => {
    const redirectLoopback = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/redirect-loopback`
      }
    })
    expect(redirectLoopback.status).toBe(403)
    expect(redirectLoopback.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await redirectLoopback.json()) as { code?: string }).code).toBe('BLOCKED_HIGH_RISK')

    const tooManyHops = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/redirect-hop?hop=0`
      }
    })
    expect(tooManyHops.status).toBe(508)
    expect(tooManyHops.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await tooManyHops.json()) as { code?: string }).code).toBe('TOO_MANY_REDIRECTS')

    const crossOriginRedirect = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-auth': 'Bearer top-secret-token',
        'x-target-url': `http://private-nas.local:${upstreamPort}/redirect-cross-origin`
      }
    })
    expect(crossOriginRedirect.status).toBe(200)
    expect(crossOriginRedirect.headers.get('x-easyviewer-proxy')).toBe('1')
    const crossPayload = (await crossOriginRedirect.json()) as {
      auth: string | null
      cookie: string | null
    }
    expect(crossPayload.auth).toBeNull()
    expect(crossPayload.cookie).toBeNull()
  })

  it('rejects oversized upstream responses (413 RESPONSE_TOO_LARGE) and clamps client x-max-response-bytes', async () => {
    const declaredLarge = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-max-response-bytes': String(999 * 1024 * 1024),
        'x-target-url': `http://private-nas.local:${upstreamPort}/large-declared`
      }
    })
    expect(declaredLarge.status).toBe(413)
    expect(declaredLarge.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await declaredLarge.json()) as { code?: string }).code).toBe('RESPONSE_TOO_LARGE')

    const streamLarge = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/large-stream`
      }
    })
    expect(streamLarge.status).toBe(413)
    expect(streamLarge.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await streamLarge.json()) as { code?: string }).code).toBe('RESPONSE_TOO_LARGE')

    const clientSmallerCap = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-max-response-bytes': '5',
        'x-target-url': `http://private-nas.local:${upstreamPort}/book.txt`
      }
    })
    expect(clientSmallerCap.status).toBe(413)
  })

  it('enforces total request+stream deadline timeoutMs (504 TIMEOUT) even on trickling streams', async () => {
    const timedOut = await fetch(`http://127.0.0.1:${deadlineProxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${deadlineProxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/slow-stream`
      }
    })
    expect(timedOut.status).toBe(504)
    expect(timedOut.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await timedOut.json()) as { code?: string }).code).toBe('TIMEOUT')
  })

  it('rejects self-signed HTTPS by default, blocks x-allow-insecure-tls without valid token, and succeeds with valid token', async () => {
    const defaultSelfSigned = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `https://private-nas.local:${httpsUpstreamPort}/book.txt`
      }
    })
    expect(defaultSelfSigned.status).toBe(502)
    expect(defaultSelfSigned.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await defaultSelfSigned.json()) as { code?: string }).code).toBe(
      'SELF_SIGNED_TLS_CONFIRM_REQUIRED'
    )

    const missingNonceInsecure = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-allow-private-nas': '1',
        'x-allow-insecure-tls': '1',
        'x-target-url': `https://private-nas.local:${httpsUpstreamPort}/book.txt`
      }
    })
    expect(missingNonceInsecure.status).toBe(403)
    expect(missingNonceInsecure.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(((await missingNonceInsecure.json()) as { code?: string }).code).toBe(
      'INVALID_SESSION_TOKEN'
    )

    const allowedSelfSigned = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-allow-insecure-tls': '1',
        'x-target-url': `https://private-nas.local:${httpsUpstreamPort}/book.txt`
      }
    })
    expect(allowedSelfSigned.status).toBe(200)
    expect(allowedSelfSigned.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(await allowedSelfSigned.text()).toBe('ok-from-self-signed-https')
  })

  it('marks upstream 404 responses with X-EasyViewer-Proxy: 1 header', async () => {
    const upstream404 = await fetch(`http://127.0.0.1:${proxyPort}/__remote_proxy`, {
      method: 'GET',
      headers: {
        Origin: `http://127.0.0.1:${proxyPort}`,
        'x-proxy-session-token': sessionToken,
        'x-allow-private-nas': '1',
        'x-target-url': `http://private-nas.local:${upstreamPort}/upstream-404`
      }
    })
    expect(upstream404.status).toBe(404)
    expect(upstream404.headers.get('x-easyviewer-proxy')).toBe('1')
    expect(await upstream404.text()).toBe('missing-upstream-resource')
  })
})
