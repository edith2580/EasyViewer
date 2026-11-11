import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const env = { ...process.env }

// Android 15+ 16KB 페이지 사이즈 호환성 및 DT_HASH 플래그 강제 주입
const extraRustFlags = ['-C', 'link-arg=-Wl,-z,max-page-size=16384', '-C', 'link-arg=-Wl,--hash-style=both']
env.RUSTFLAGS = [env.RUSTFLAGS || '', ...extraRustFlags].filter(Boolean).join(' ')
env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS || '', ...extraRustFlags].filter(Boolean).join('\x1f')

if (!env.JAVA_HOME && fs.existsSync('D:\\android\\jdk-21')) {
  env.JAVA_HOME = 'D:\\android\\jdk-21'
}

if (!env.ANDROID_HOME && fs.existsSync('D:\\android\\sdk')) {
  env.ANDROID_HOME = 'D:\\android\\sdk'
}

if (!env.ANDROID_SDK_ROOT && env.ANDROID_HOME) {
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME
}

if (!env.NDK_HOME && env.ANDROID_HOME) {
  const ndkRoot = path.join(env.ANDROID_HOME, 'ndk')
  if (fs.existsSync(ndkRoot)) {
    const versions = fs.readdirSync(ndkRoot).sort()
    // Prefer LTS NDK 28.x if installed, otherwise latest
    const preferred = versions.find((v) => v.startsWith('28.')) || versions[versions.length - 1]
    if (preferred) {
      env.NDK_HOME = path.join(ndkRoot, preferred)
    }
  }
}

const isWin = process.platform === 'win32'
const tauriBin = path.join(process.cwd(), 'node_modules', '.bin', isWin ? 'tauri.cmd' : 'tauri')
const tauriCmd = fs.existsSync(tauriBin) ? `"${tauriBin}"` : 'tauri'

const args = [tauriCmd, 'android', ...process.argv.slice(2)]
const child = spawn(args.join(' '), {
  stdio: 'inherit',
  shell: true,
  env
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
