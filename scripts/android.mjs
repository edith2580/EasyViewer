import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const env = { ...process.env }

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
