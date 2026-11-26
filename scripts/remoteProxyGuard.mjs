import crypto from 'node:crypto'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'POST'])
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024
const HARD_MAX_RESPONSE_BODY_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BODY_BYTES = HARD_MAX_RESPONSE_BODY_BYTES
const DEFAULT_TIMEOUT_MS = 30_000
const MIN_CLIENT_TIMEOUT_MS = 1_000
const MAX_CLIENT_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 5
const PROXY_MARKER_HEADER = 'X-EasyViewer-Proxy'

function clampMaxResponseBytes(rawHeader, serverCap) {
  const ceiling = Math.min(Math.max(1, Number(serverCap) || HARD_MAX_RESPONSE_BODY_BYTES), HARD_MAX_RESPONSE_BODY_BYTES)
  const parsed = Number(rawHeader)
  if (typeof rawHeader === 'string' && rawHeader.trim() !== '' && Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), ceiling)
  }
  return ceiling
}

function clampTimeoutMs(rawHeader, defaultMs) {
  const parsed = Number(rawHeader)
  if (typeof rawHeader === 'string' && rawHeader.trim() !== '' && Number.isFinite(parsed) && parsed > 0) {
    return Math.min(MAX_CLIENT_TIMEOUT_MS, Math.max(MIN_CLIENT_TIMEOUT_MS, Math.floor(parsed)))
  }
  return defaultMs
}

function parseIpv4Part(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16)
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8)
  if (/^(0|[1-9]\d*)$/.test(part)) return Number.parseInt(part, 10)
  return null
}

function parseIpv4Bytes(host) {
  if (host.includes('.')) {
    const parts = host.split('.')
    if (parts.length !== 4) return null
    const octets = []
    for (const part of parts) {
      const val = parseIpv4Part(part)
      if (val === null || !Number.isFinite(val) || val < 0 || val > 255) return null
      octets.push(val)
    }
    return octets
  }
  const intVal = parseIpv4Part(host)
  if (intVal !== null && Number.isFinite(intVal) && intVal >= 0 && intVal <= 0xffffffff) {
    return [(intVal >>> 24) & 0xff, (intVal >>> 16) & 0xff, (intVal >>> 8) & 0xff, intVal & 0xff]
  }
  return null
}

function classifyIpv4Bytes([a, b]) {
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) {
    return 'blocked-high-risk'
  }
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return 'private-network'
  }
  return 'public'
}

function expandIpv6Groups(raw) {
  let addr = raw.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (!addr.includes(':')) return null
  const lastColon = addr.lastIndexOf(':')
  const tail = addr.slice(lastColon + 1)
  let embeddedV4Groups = null
  if (tail.includes('.')) {
    const v4 = parseIpv4Bytes(tail)
    if (!v4) return null
    embeddedV4Groups = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    addr = addr.slice(0, lastColon)
    if (addr.endsWith(':') && !addr.endsWith('::')) addr = `${addr}0`
    else if (!addr.includes(':')) addr = addr === '' ? '::' : `${addr}:`
  }
  const parts = addr.split('::')
  if (parts.length > 2) return null
  const parseSegs = (seg) => {
    if (!seg) return []
    const items = seg.split(':')
    const out = []
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      out.push(Number.parseInt(item, 16))
    }
    return out
  }
  const head = parseSegs(parts[0])
  if (!head) return null
  const tailGroups = parts.length === 2 ? parseSegs(parts[1]) : []
  if (!tailGroups) return null
  const totalExplicit = head.length + tailGroups.length + (embeddedV4Groups ? 2 : 0)
  if (parts.length === 1 && totalExplicit !== 8) return null
  if (parts.length === 2 && totalExplicit > 8) return null
  const zeros = new Array(8 - totalExplicit).fill(0)
  return [...head, ...zeros, ...tailGroups, ...(embeddedV4Groups || [])]
}

export function classifyIpAddress(rawIp) {
  const cleaned = String(rawIp || '').trim().replace(/^\[|\]$/g, '').split('%')[0]
  if (!cleaned) return 'blocked-high-risk'
  const v4 = parseIpv4Bytes(cleaned)
  if (v4) return classifyIpv4Bytes(v4)
  const v6 = expandIpv6Groups(cleaned)
  if (v6) {
    const isMapped = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff
    if (isMapped) {
      return classifyIpv4Bytes([(v6[6] >>> 8) & 0xff, v6[6] & 0xff, (v6[7] >>> 8) & 0xff, v6[7] & 0xff])
    }
    const allZero = v6.every((g) => g === 0)
    const isLoopback = v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1
    const isLinkLocal = (v6[0] & 0xffc0) === 0xfe80
    const isMulticast = (v6[0] & 0xff00) === 0xff00
    if (allZero || isLoopback || isLinkLocal || isMulticast) return 'blocked-high-risk'
    if ((v6[0] & 0xfe00) === 0xfc00) return 'private-network'
    return 'public'
  }
  return 'public'
}

function makeProxyError(message, statusCode, code) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

export function validateRemoteUrlSyntax(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || '').trim())
  } catch {
    throw makeProxyError('유효하지 않은 원격 URL입니다.', 400, 'INVALID_URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw makeProxyError(`허용되지 않은 프로토콜입니다: ${parsed.protocol}`, 403, 'BLOCKED_SCHEME')
  }
  if (parsed.username || parsed.password) {
    throw makeProxyError('URL 내 자격 증명은 허용되지 않습니다.', 400, 'INVALID_URL')
  }
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase()
  if (!hostname) {
    throw makeProxyError('원격 호스트가 비어 있습니다.', 400, 'INVALID_URL')
  }
  let classification = 'public'
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    classification = 'blocked-high-risk'
  } else if (parseIpv4Bytes(hostname) || hostname.startsWith('[') || hostname.includes(':')) {
    classification = classifyIpAddress(hostname)
  } else if (hostname.endsWith('.local')) {
    classification = 'private-network'
  }
  return { url: parsed, hostname, classification }
}

/**
 * Resolves DNS records once, classifies every returned IP, and binds a pinned lookup callback for http(s).request.
 */
export async function resolveAndValidateHost(
  urlStr,
  { allowPrivateNetwork = false, dnsLookup, testDnsOverride } = {}
) {
  const validated = validateRemoteUrlSyntax(urlStr)
  const { hostname, url, classification: syntaxClass } = validated

  if (syntaxClass === 'blocked-high-risk') {
    throw makeProxyError('보안 정책에 의해 차단된 내부 네트워크 주소입니다.', 403, 'BLOCKED_HIGH_RISK')
  }

  const isIpLiteral = Boolean(
    parseIpv4Bytes(hostname) || hostname.startsWith('[') || hostname.includes(':')
  )

  let records
  if (isIpLiteral) {
    const cleanLiteral = hostname.replace(/^\[|\]$/g, '')
    records = [{ address: cleanLiteral, family: cleanLiteral.includes(':') ? 6 : 4 }]
  } else if (typeof testDnsOverride === 'function') {
    records = await testDnsOverride(hostname)
  } else if (typeof dnsLookup === 'function') {
    records = await dnsLookup(hostname, { all: true })
  } else {
    records = await dns.promises.lookup(hostname, { all: true })
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw makeProxyError('원격 호스트의 IP 주소를 해석할 수 없습니다.', 502, 'DNS_RESOLUTION_FAILED')
  }

  let overallClass = syntaxClass
  for (const record of records) {
    const recordClass = record.simulatedClassification || classifyIpAddress(record.address)
    if (recordClass === 'blocked-high-risk') {
      throw makeProxyError('보안 정책에 의해 차단된 내부 네트워크 주소입니다.', 403, 'BLOCKED_HIGH_RISK')
    }
    if (recordClass === 'private-network') {
      overallClass = 'private-network'
    }
  }

  if (overallClass === 'private-network' && !allowPrivateNetwork) {
    throw makeProxyError(
      '사설 네트워크(NAS) 접근에는 사용자 승인이 필요합니다.',
      403,
      'PRIVATE_NETWORK_CONFIRM_REQUIRED'
    )
  }

  const pinned = records[0]
  const pinnedLookup = (_hostname, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb
    const opts = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb : {}
    if (opts.all) {
      cb(null, [{ address: pinned.address, family: pinned.family }])
    } else {
      cb(null, pinned.address, pinned.family)
    }
  }

  return {
    url,
    hostname,
    address: pinned.address,
    family: pinned.family,
    classification: overallClass,
    pinnedLookup
  }
}

function timingSafeTokenMatch(expected, actual) {
  if (!expected || typeof actual !== 'string' || !actual) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function sendJsonError(res, statusCode, message, code) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = statusCode
  res.setHeader(PROXY_MARKER_HEADER, '1')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: message, code }))
}

/**
 * DNS-rebinding guard. This middleware is installed from `configureServer`, so it runs *before*
 * Vite's own host check. A rebinding page (attacker.example resolving to 127.0.0.1) sends
 * `Host: attacker.example` together with a matching Origin, which passes the same-origin check
 * below — so the Host itself must be a loopback name, an IP literal (cannot be rebound), or a host
 * configured explicitly (TAURI_DEV_HOST / server.allowedHosts).
 */
export function isAllowedProxyHost(hostHeader, extraAllowedHosts = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false
  let hostname
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase()
  } catch {
    return false
  }
  hostname = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return true
  return extraAllowedHosts
    .filter((h) => typeof h === 'string' && h)
    .map((h) => h.toLowerCase().replace(/\.$/, ''))
    .some((allowed) =>
      allowed.startsWith('.') ? hostname === allowed.slice(1) || hostname.endsWith(allowed) : hostname === allowed
    )
}

function validateSameOrigin(req) {
  const hostHeader = req.headers.host
  if (!hostHeader) return false

  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
    return false
  }

  const originHeader = req.headers.origin
  const refererHeader = req.headers.referer
  if (typeof originHeader === 'string' && originHeader) {
    try {
      return new URL(originHeader).host === hostHeader
    } catch {
      return false
    }
  }
  if (typeof refererHeader === 'string' && refererHeader) {
    try {
      return new URL(refererHeader).host === hostHeader
    } catch {
      return false
    }
  }
  return false
}

function collectRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let finished = false
    req.on('data', (chunk) => {
      if (finished) return
      received += chunk.length
      if (received > maxBytes) {
        finished = true
        req.resume()
        reject(makeProxyError('요청 본문이 허용 상한(1 MiB)을 초과했습니다.', 413, 'PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!finished) {
        finished = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (err) => {
      if (!finished) {
        finished = true
        reject(err)
      }
    })
  })
}

/**
 * Creates a fail-closed, SSRF/DNS-pinning remote proxy handler for Vite Dev & Preview.
 */
export function createRemoteProxyHandler({
  sessionToken = '',
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  maxResponseBodyBytes = DEFAULT_MAX_RESPONSE_BODY_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  testDnsOverride,
  allowedHosts = []
} = {}) {
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith('/__remote_proxy')) {
      next()
      return
    }

    res.setHeader(PROXY_MARKER_HEADER, '1')

    const extraHosts = typeof allowedHosts === 'function' ? allowedHosts() : allowedHosts
    if (!isAllowedProxyHost(req.headers.host, Array.isArray(extraHosts) ? extraHosts : [])) {
      sendJsonError(res, 403, '허용되지 않은 Host 헤더입니다.', 'FORBIDDEN_HOST')
      return
    }

    if (!validateSameOrigin(req)) {
      sendJsonError(res, 403, '허용되지 않은 교차 출처 요청입니다.', 'FORBIDDEN_ORIGIN')
      return
    }

    const reqMethod = String(req.method || 'GET').toUpperCase()
    const overrideMethod =
      typeof req.headers['x-target-method'] === 'string' && req.headers['x-target-method']
        ? req.headers['x-target-method'].toUpperCase()
        : reqMethod

    if (!ALLOWED_METHODS.has(reqMethod) || !ALLOWED_METHODS.has(overrideMethod)) {
      sendJsonError(res, 405, `허용되지 않은 HTTP 메서드입니다: ${overrideMethod}`, 'METHOD_NOT_ALLOWED')
      return
    }

    const rawTargetUrl = req.headers['x-target-url']
    if (typeof rawTargetUrl !== 'string' || !rawTargetUrl.trim()) {
      sendJsonError(res, 400, '대상 URL(x-target-url)이 필요합니다.', 'INVALID_URL')
      return
    }

    const wantPrivate = req.headers['x-allow-private-nas'] === '1'
    const wantInsecureTls = req.headers['x-allow-insecure-tls'] === '1'
    const clientToken = req.headers['x-proxy-session-token']
    const hasValidToken = timingSafeTokenMatch(sessionToken, typeof clientToken === 'string' ? clientToken : '')

    if ((wantPrivate || wantInsecureTls) && !hasValidToken) {
      sendJsonError(
        res,
        403,
        '사설망 또는 예외 TLS 요청에는 유효한 세션 토큰이 필요합니다.',
        'INVALID_SESSION_TOKEN'
      )
      return
    }

    const effectiveMaxResponseBytes = clampMaxResponseBytes(
      req.headers['x-max-response-bytes'],
      maxResponseBodyBytes
    )
    const effectiveTimeoutMs = clampTimeoutMs(req.headers['x-request-timeout-ms'], timeoutMs)
    const deadlineAt = Date.now() + effectiveTimeoutMs

    let finalized = false
    let activeUpstreamReq = null
    let activeUpstreamRes = null
    let deadlineTimer = null

    const cleanup = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
    }

    const failAndFinish = (statusCode, message, code) => {
      if (finalized) return
      finalized = true
      cleanup()
      if (activeUpstreamRes && !activeUpstreamRes.destroyed) activeUpstreamRes.destroy()
      if (activeUpstreamReq && !activeUpstreamReq.destroyed) activeUpstreamReq.destroy()
      sendJsonError(res, statusCode, message, code)
    }

    deadlineTimer = setTimeout(() => {
      failAndFinish(504, '원격 요청 전체 처리 시간이 초과되었습니다.', 'TIMEOUT')
    }, effectiveTimeoutMs)

    res.on('close', () => {
      finalized = true
      cleanup()
      if (activeUpstreamRes && !activeUpstreamRes.destroyed) activeUpstreamRes.destroy()
      if (activeUpstreamReq && !activeUpstreamReq.destroyed) activeUpstreamReq.destroy()
    })

    let requestBody
    try {
      requestBody = await collectRequestBody(req, maxRequestBodyBytes)
    } catch (err) {
      failAndFinish(err.statusCode || 413, err.message, err.code || 'PAYLOAD_TOO_LARGE')
      return
    }
    if (finalized) return

    const baseHeaders = {}
    if (typeof req.headers['x-target-auth'] === 'string' && req.headers['x-target-auth']) {
      baseHeaders.Authorization = req.headers['x-target-auth']
    }
    if (typeof req.headers['x-target-depth'] === 'string' && req.headers['x-target-depth']) {
      baseHeaders.Depth = req.headers['x-target-depth']
    }
    if (typeof req.headers['content-type'] === 'string' && req.headers['content-type']) {
      baseHeaders['Content-Type'] = req.headers['content-type']
    }

    let initialOrigin = ''
    try {
      initialOrigin = new URL(rawTargetUrl).origin
    } catch {
      failAndFinish(400, '유효하지 않은 원격 URL입니다.', 'INVALID_URL')
      return
    }

    const forward = async (currentUrlStr, method, redirectCount = 0) => {
      if (finalized) return
      if (redirectCount > MAX_REDIRECTS) {
        failAndFinish(508, '리다이렉트 횟수(5회)를 초과했습니다.', 'TOO_MANY_REDIRECTS')
        return
      }

      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        failAndFinish(504, '원격 요청 전체 처리 시간이 초과되었습니다.', 'TIMEOUT')
        return
      }

      let resolved
      try {
        resolved = await resolveAndValidateHost(currentUrlStr, {
          allowPrivateNetwork: wantPrivate && hasValidToken,
          testDnsOverride
        })
      } catch (err) {
        failAndFinish(err.statusCode || 403, err.message, err.code || 'BLOCKED_HIGH_RISK')
        return
      }
      if (finalized) return

      const parsedUrl = resolved.url
      const isHttps = parsedUrl.protocol === 'https:'
      const transport = isHttps ? https : http

      const outHeaders = {
        Host: parsedUrl.host,
        'User-Agent': 'EasyViewer-WebDAV/1.0',
        Accept: '*/*',
        ...baseHeaders
      }
      if (parsedUrl.origin !== initialOrigin) {
        delete outHeaders.Authorization
        delete outHeaders.Cookie
      }
      if (requestBody.length > 0 && method !== 'GET' && method !== 'HEAD') {
        outHeaders['Content-Length'] = requestBody.length
      } else {
        delete outHeaders['Content-Length']
      }

      const reqOpts = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        headers: outHeaders,
        lookup: resolved.pinnedLookup,
        timeout: Math.max(1, remainingMs)
      }
      if (isHttps) {
        reqOpts.rejectUnauthorized = !(wantInsecureTls && hasValidToken)
        reqOpts.servername = parsedUrl.hostname
      }

      const proxyReq = transport.request(reqOpts, (proxyRes) => {
        activeUpstreamRes = proxyRes
        if (finalized) {
          proxyRes.destroy()
          return
        }
        const statusCode = proxyRes.statusCode || 500
        const locationHeader = proxyRes.headers.location
        if ([301, 302, 303, 307, 308].includes(statusCode) && typeof locationHeader === 'string' && locationHeader) {
          let nextUrl
          try {
            nextUrl = new URL(locationHeader, parsedUrl).toString()
          } catch {
            proxyRes.resume()
            failAndFinish(502, '잘못된 리다이렉트 Location입니다.', 'INVALID_REDIRECT')
            return
          }
          const nextMethod = statusCode === 303 ? 'GET' : method
          proxyRes.resume()
          void forward(nextUrl, nextMethod, redirectCount + 1)
          return
        }

        const declaredLength = Number(proxyRes.headers['content-length'] || '0')
        if (declaredLength > effectiveMaxResponseBytes) {
          proxyRes.destroy()
          failAndFinish(413, '원격 응답 크기가 허용 상한을 초과했습니다.', 'RESPONSE_TOO_LARGE')
          return
        }

        const chunks = []
        let totalReceived = 0
        proxyRes.on('data', (chunk) => {
          if (finalized) return
          totalReceived += chunk.length
          if (totalReceived > effectiveMaxResponseBytes) {
            failAndFinish(413, '원격 응답 크기가 허용 상한을 초과했습니다.', 'RESPONSE_TOO_LARGE')
            return
          }
          chunks.push(chunk)
        })
        proxyRes.on('end', () => {
          if (finalized) return
          finalized = true
          cleanup()
          res.statusCode = statusCode
          res.setHeader(PROXY_MARKER_HEADER, '1')
          if (proxyRes.headers['content-type']) {
            res.setHeader('Content-Type', proxyRes.headers['content-type'])
          }
          const payload = Buffer.concat(chunks)
          res.setHeader('Content-Length', payload.length)
          res.end(payload)
        })
        proxyRes.on('error', (err) => {
          if (!finalized) {
            failAndFinish(502, `원격 응답 수신 오류: ${err.message}`, 'REMOTE_STREAM_FAILED')
          }
        })
      })
      activeUpstreamReq = proxyReq

      proxyReq.on('timeout', () => {
        if (!finalized) {
          failAndFinish(504, '원격 요청 시간이 초과되었습니다.', 'TIMEOUT')
        }
      })

      proxyReq.on('error', (err) => {
        if (finalized) return
        const msg = String(err?.message || '')
        const lower = msg.toLowerCase()
        if (
          isHttps &&
          !(wantInsecureTls && hasValidToken) &&
          (lower.includes('certificate') ||
            lower.includes('self signed') ||
            lower.includes('self-signed') ||
            lower.includes('unable to verify') ||
            String(err?.code || '').includes('CERT'))
        ) {
          failAndFinish(
            502,
            '자체 서명 또는 신뢰할 수 없는 TLS 인증서입니다.',
            'SELF_SIGNED_TLS_CONFIRM_REQUIRED'
          )
          return
        }
        failAndFinish(err.statusCode || 502, `원격 서버 연결 실패: ${msg}`, err.code || 'REMOTE_FETCH_FAILED')
      })

      if (requestBody.length > 0 && method !== 'GET' && method !== 'HEAD') {
        proxyReq.write(requestBody)
      }
      proxyReq.end()
    }

    await forward(rawTargetUrl, overrideMethod, 0)
  }
}
