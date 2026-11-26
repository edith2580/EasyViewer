import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { createRemoteProxyHandler } from './scripts/remoteProxyGuard.mjs'

const pkgJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as { version?: string }
const APP_VERSION = pkgJson.version || '0.0.0'

const host = process.env.TAURI_DEV_HOST

function easyViewerRemoteProxyPlugin(): Plugin {
  const sessionToken = crypto.randomBytes(24).toString('hex')
  // Host names the proxy accepts besides loopback/IP literals (DNS-rebinding guard; the proxy runs
  // before Vite's own host check). Filled from the resolved server config.
  let configuredHosts: string[] = []
  const handleProxy = createRemoteProxyHandler({ sessionToken, allowedHosts: () => configuredHosts })

  return {
    name: 'easyviewer-remote-proxy',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta name="ev-proxy-token" content="${sessionToken}">`
      )
    },
    configResolved(config) {
      const collect = (value: unknown) => (Array.isArray(value) ? value.filter((h) => typeof h === 'string') : [])
      configuredHosts = [
        ...(host ? [host] : []),
        ...collect(config.server.allowedHosts),
        ...collect(config.preview.allowedHosts)
      ]
    },
    configureServer(server) {
      server.middlewares.use(handleProxy)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleProxy)
    }
  }
}

/**
 * The Tauri app gets its Content-Security-Policy from `app.security.csp` in tauri.conf.json, but
 * the plain web build (static hosting, `vite preview`) had none, so a script that got past the
 * EPUB sanitizer could reach the whole app origin. For web builds the same policy is injected as a
 * `<meta>` tag; `connect-src` additionally allows http(s) because the web build fetches remote
 * books directly when no proxy is available. Tauri builds (TAURI_ENV_PLATFORM is set by the Tauri
 * CLI for beforeBuildCommand) are left untouched. `vite` dev serve is not covered (HMR needs
 * inline styles and a websocket).
 */
function buildWebCspMeta(): string {
  const conf = JSON.parse(
    fs.readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf-8')
  ) as { app?: { security?: { csp?: Record<string, string> } } }
  const csp = { ...(conf.app?.security?.csp ?? {}) }
  csp['connect-src'] = `${csp['connect-src'] ?? "'self'"} https: http:`
  const policy = Object.entries(csp)
    .map(([directive, value]) => `${directive} ${value}`)
    .join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`
}

function easyViewerWebCspPlugin(): Plugin {
  return {
    name: 'easyviewer-web-csp',
    apply: 'build',
    transformIndexHtml(html) {
      if (process.env.TAURI_ENV_PLATFORM) return html
      return html.replace('<head>', `<head>\n    ${buildWebCspMeta()}`)
    }
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION)
  },
  plugins: [vue(), easyViewerRemoteProxyPlugin(), easyViewerWebCspPlugin()],
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
