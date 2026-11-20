import { describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import { createPinia, setActivePinia } from 'pinia'

describe('PlatformStorageAdapter & initLibrary IPC characterization', () => {
  it('sanitizes filenames safely across Windows/macOS/Linux rules', async () => {
    const { sanitizeFileName } = await import('@/services/storage/platformAdapter')
    expect(sanitizeFileName('con.txt')).toBe('_con.txt')
    expect(sanitizeFileName('책<>:"/\\|?*제목 .epub')).toBe('책_________제목.epub')
  })

  it('operates in web fallback mode when Tauri internals are absent', async () => {
    vi.resetModules()
    const { isDesktopApp, isTauriEnv, platformStorage } = await import('@/services/storage/platformAdapter')

    expect(isTauriEnv()).toBe(false)
    expect(await isDesktopApp()).toBe(false)

    await platformStorage.setItem('unit_key', { ok: true })
    expect(await platformStorage.getItem('unit_key', { ok: false })).toEqual({ ok: true })
  })

  it('bounds native IPC calls during desktop initLibrary and prepareBookFiles (no O(N) redundant allow_storage_dir)', async () => {
    vi.resetModules()
    const calls: Array<{ cmd: string; payload: unknown }> = []

    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload })
      if (cmd === 'is_desktop') return true
      if (cmd === 'allow_storage_dir') return null
      if (cmd === 'plugin:path|resolve_directory') return '/tmp/app-data'
      if (cmd === 'plugin:path|join') {
        const args = payload as { paths?: string[] }
        return (args.paths || []).join('/')
      }
      if (cmd === 'plugin:path|dirname') {
        const args = payload as { path?: string }
        const p = args.path || ''
        return p.slice(0, Math.max(0, p.lastIndexOf('/')))
      }
      return null
    })

    const { platformStorage } = await import('@/services/storage/platformAdapter')
    await platformStorage.setItem('samples_seeded_v1', true)
    await platformStorage.setItem(
      'library_books_v1',
      Array.from({ length: 12 }, (_, idx) => ({
        id: `book-${idx}`,
        title: `Book ${idx}`,
        author: 'Author',
        format: 'txt',
        fileSize: 100,
        storedPath: `/Users/tester/Books/book-${idx}.txt`,
        addedAt: 1000 + idx,
        lastOpenedAt: 1000 + idx
      }))
    )

    calls.length = 0
    setActivePinia(createPinia())
    const { useBookStore } = await import('@/stores/useBookStore')
    const store = useBookStore()
    await store.initLibrary()

    const allowCalls = calls.filter((c) => c.cmd === 'allow_storage_dir')
    // All 12 books live in the same directory (+ 1 default dir), so Set deduplication keeps allow_storage_dir <= 2
    expect(allowCalls.length).toBeLessThanOrEqual(2)
  })

  it('validates storage dir with allow_storage_dir before opening via @tauri-apps/plugin-opener (T066)', async () => {
    vi.resetModules()
    const calls: string[] = []
    mockIPC((cmd) => {
      calls.push(cmd)
      if (cmd === 'plugin:path|resolve_directory') return '/Users/tester/Library/Application Support/EasyViewer'
      if (cmd === 'plugin:path|join') return '/Users/tester/Books'
      if (cmd === 'allow_storage_dir') return null
      if (cmd === 'plugin:opener|open_path') return null
      return null
    })

    const { platformStorage } = await import('@/services/storage/platformAdapter')
    await platformStorage.openStorageDir()
    expect(calls).not.toContain('open_folder')
    expect(calls.indexOf('allow_storage_dir')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('plugin:opener|open_path')).toBeGreaterThan(
      calls.indexOf('allow_storage_dir')
    )

    vi.resetModules()
    const blockedCalls: string[] = []
    mockIPC((cmd) => {
      blockedCalls.push(cmd)
      if (cmd === 'plugin:path|resolve_directory') return '/etc'
      if (cmd === 'plugin:path|join') return '/etc/books'
      if (cmd === 'allow_storage_dir') {
        throw new Error('SECURITY_DENIED: sensitive path')
      }
      if (cmd === 'plugin:opener|open_path') return null
      return null
    })

    const { platformStorage: blockedStorage } = await import('@/services/storage/platformAdapter')
    await expect(blockedStorage.openStorageDir()).rejects.toThrow('SECURITY_DENIED')
    expect(blockedCalls).not.toContain('plugin:opener|open_path')
  })
})
