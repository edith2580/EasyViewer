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
  const handleProxy = createRemoteProxyHandler({ sessionToken })

  return {
    name: 'easyviewer-remote-proxy',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta name="ev-proxy-token" content="${sessionToken}">`
      )
    },
    configureServer(server) {
      server.middlewares.use(handleProxy)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleProxy)
    }
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION)
  },
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
