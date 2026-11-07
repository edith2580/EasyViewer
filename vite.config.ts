import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import http from 'node:http'
import https from 'node:https'

const host = process.env.TAURI_DEV_HOST

function easyViewerRemoteProxyPlugin(): Plugin {
  const handleProxy = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith('/__remote_proxy')) {
      next()
      return
    }

    const targetUrl = req.headers['x-target-url']
    if (typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
      res.statusCode = 400
      res.end('Missing or invalid x-target-url header')
      return
    }

    const targetMethod =
      (typeof req.headers['x-target-method'] === 'string' && req.headers['x-target-method']) ||
      req.method ||
      'GET'
    const targetAuth = req.headers['x-target-auth']
    const targetDepth = req.headers['x-target-depth']
    const contentType = req.headers['content-type']

    const bodyChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk))
    req.on('end', () => {
      const requestBody = Buffer.concat(bodyChunks)

      const forwardRequest = (currentUrlStr: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          res.statusCode = 508
          res.end('Too many redirects')
          return
        }

        let parsedUrl: URL
        try {
          parsedUrl = new URL(currentUrlStr)
        } catch {
          res.statusCode = 400
          res.end('Invalid target URL')
          return
        }

        const isHttps = parsedUrl.protocol === 'https:'
        const client = isHttps ? https : http

        const outHeaders: Record<string, string | number> = {
          Host: parsedUrl.host,
          'User-Agent': 'EasyViewer-WebDAV/1.0',
          Accept: '*/*'
        }
        if (typeof targetAuth === 'string' && targetAuth) {
          outHeaders.Authorization = targetAuth
        }
        if (typeof targetDepth === 'string' && targetDepth) {
          outHeaders.Depth = targetDepth
        }
        if (typeof contentType === 'string' && contentType) {
          outHeaders['Content-Type'] = contentType
        }
        if (requestBody.length > 0) {
          outHeaders['Content-Length'] = requestBody.length
        }

        const proxyReq = client.request(
          parsedUrl,
          {
            method: targetMethod,
            headers: outHeaders,
            rejectUnauthorized: false
          },
          (proxyRes) => {
            const statusCode = proxyRes.statusCode || 500
            const locationHeader = proxyRes.headers.location
            if (
              [301, 302, 303, 307, 308].includes(statusCode) &&
              typeof locationHeader === 'string' &&
              locationHeader
            ) {
              const nextUrl = new URL(locationHeader, parsedUrl).toString()
              proxyRes.resume()
              forwardRequest(nextUrl, redirectCount + 1)
              return
            }

            res.statusCode = statusCode
            if (proxyRes.headers['content-type']) {
              res.setHeader('Content-Type', proxyRes.headers['content-type'])
            }
            if (proxyRes.headers['content-length']) {
              res.setHeader('Content-Length', proxyRes.headers['content-length'])
            }
            res.setHeader('Access-Control-Allow-Origin', '*')
            proxyRes.pipe(res)
          }
        )

        proxyReq.on('error', (err) => {
          res.statusCode = 502
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(`원격 서버 연결 실패: ${err.message}`)
        })

        if (requestBody.length > 0) {
          proxyReq.write(requestBody)
        }
        proxyReq.end()
      }

      forwardRequest(targetUrl)
    })
  }

  return {
    name: 'easyviewer-remote-proxy',
    configureServer(server) {
      server.middlewares.use(handleProxy)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleProxy)
    }
  }
}

export default defineConfig({
  plugins: [vue(), easyViewerRemoteProxyPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
})
