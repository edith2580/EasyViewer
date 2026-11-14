/**
 * Platform Abstraction Layer (Tauri 2 Native FS/Store + Web IndexedDB/LocalStorage Fallback)
 * Supports Windows, macOS, Android, iOS (via Tauri 2) and Web browsers seamlessly.
 */

const DB_NAME = 'EasyViewerDB'
const DB_VERSION = 1
const STORE_FILES = 'book_files'
const STORE_KV = 'key_value'

const STORAGE_DIR_KEY = 'storage_dir_v1'

export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

let desktopAppCache: boolean | null = null

/** True in the Windows/macOS/Linux app (not the web build, not Android/iOS). */
export async function isDesktopApp(): Promise<boolean> {
  if (!isTauriEnv()) return false
  if (desktopAppCache !== null) return desktopAppCache
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    desktopAppCache = await invoke<boolean>('is_desktop')
  } catch {
    desktopAppCache = false
  }
  return desktopAppCache
}

async function invokeCommand<T = void>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** Makes a book's original file name safe to use on Windows, macOS and Linux. */
export function sanitizeFileName(name: string, fallback = 'book'): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  let base = (dot > 0 ? name.slice(0, dot) : name)
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`
  if (!base) base = fallback
  if (base.length > 150) base = base.slice(0, 150).trim()
  return base + ext.replace(/[^.\w]/g, '').toLowerCase()
}

/** Path form used only for comparing paths (separators, trailing slash, case on Windows/macOS). */
function comparablePath(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const caseInsensitive =
    typeof navigator !== 'undefined' && /Windows|Macintosh|Mac OS X/i.test(navigator.userAgent)
  return caseInsensitive ? unified.toLowerCase() : unified
}

function isInsideDir(dir: string, filePath: string): boolean {
  return comparablePath(filePath).startsWith(`${comparablePath(dir)}/`)
}

async function sameFileContent(filePath: string, data: ArrayBuffer): Promise<boolean> {
  const { stat, readFile } = await import('@tauri-apps/plugin-fs')
  if ((await stat(filePath)).size !== data.byteLength) return false
  const onDisk = await readFile(filePath)
  const added = new Uint8Array(data)
  if (onDisk.byteLength !== added.byteLength) return false
  for (let i = 0; i < added.length; i++) if (onDisk[i] !== added[i]) return false
  return true
}

/**
 * The file being added, if it already is in the storage folder: `sourcePath` when it lies inside
 * `dir`, else `dir/<same name>` when that file has identical content.
 */
async function findInStorageDir(
  dir: string,
  fileName: string,
  data: ArrayBuffer,
  sourcePath?: string
): Promise<string | undefined> {
  const { exists } = await import('@tauri-apps/plugin-fs')
  if (sourcePath && isInsideDir(dir, sourcePath) && (await exists(sourcePath))) return sourcePath

  const { join } = await import('@tauri-apps/api/path')
  const candidate = await join(dir, sanitizeFileName(fileName))
  try {
    if ((await exists(candidate)) && (await sameFileContent(candidate, data))) return candidate
  } catch {
    // Unreadable file: treat as a different file
  }
  return undefined
}

/** `dir/name`, or `dir/name (2)`, `(3)`… when a file with that name already exists. */
async function uniqueFilePath(dir: string, fileName: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  const { exists } = await import('@tauri-apps/plugin-fs')
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = await join(dir, fileName)
  for (let n = 2; await exists(candidate); n++) {
    candidate = await join(dir, `${base} (${n})${ext}`)
  }
  return candidate
}

function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES)
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export class PlatformStorageAdapter {
  // ------------------------------------------------------------------ storage folder (app only)

  /** Default folder for book files: `<app data>/books`. */
  async getDefaultStorageDir(): Promise<string> {
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    return join(await appDataDir(), 'books')
  }

  /** Folder where newly added books are saved (user-chosen, or the default). */
  async getStorageDir(): Promise<string> {
    const custom = await this.getItem<string | null>(STORAGE_DIR_KEY, null)
    return custom || this.getDefaultStorageDir()
  }

  async isCustomStorageDir(): Promise<boolean> {
    return !!(await this.getItem<string | null>(STORAGE_DIR_KEY, null))
  }

  /**
   * Changes the folder for books added from now on (null = back to the default).
   * Books already in the library stay where they are.
   */
  async setStorageDir(dir: string | null): Promise<void> {
    if (dir) await invokeCommand('allow_storage_dir', { path: dir })
    await this.setItem(STORAGE_DIR_KEY, dir)
  }

  /** Opens the storage folder in Explorer / Finder (creating it if needed). */
  async openStorageDir(): Promise<void> {
    const dir = await this.getStorageDir()
    await invokeCommand('allow_storage_dir', { path: dir })
    await invokeCommand('open_folder', { path: dir })
  }

  /**
   * Lets the app read/write the given folders in this run. Folders outside the app data
   * directory (a storage folder chosen earlier) must be allowed again after every start.
   */
  async allowStorageDirs(dirs: string[]): Promise<void> {
    if (!(await isDesktopApp())) return
    for (const dir of new Set(dirs.filter(Boolean))) {
      try {
        await invokeCommand('allow_storage_dir', { path: dir })
      } catch (err) {
        console.warn('[PlatformAdapter] Storage folder unavailable:', dir, err)
      }
    }
  }

  /**
   * Renames a book stored the old way (`<app data>/books/<id>.bin`) to a readable file name in
   * the default folder. Returns the new path, or undefined if there is no such file.
   */
  async migrateLegacyBookFile(bookId: string, fileName: string): Promise<string | undefined> {
    if (!(await isDesktopApp())) return undefined
    try {
      const { exists, rename, BaseDirectory } = await import('@tauri-apps/plugin-fs')
      const legacy = `books/${bookId}.bin`
      if (!(await exists(legacy, { baseDir: BaseDirectory.AppData }))) return undefined
      const target = await uniqueFilePath(await this.getDefaultStorageDir(), sanitizeFileName(fileName))
      await rename(legacy, target, { oldPathBaseDir: BaseDirectory.AppData })
      return target
    } catch (err) {
      console.warn('[PlatformAdapter] Could not rename legacy book file:', bookId, err)
      return undefined
    }
  }

  // ------------------------------------------------------------------ book files

  /**
   * Saves a book file.
   *  - Android/iOS app: `<app data>/books/<id>.bin`, as before (files aren't user-visible there,
   *    so the storage-folder logic below is desktop only). Returns undefined.
   *  - Browser: IndexedDB. Returns undefined.
   *  - Windows/macOS app: returns the file's path, decided in this order:
   *  1. The added file already is in the storage folder — `sourcePath` (drag & drop) lies inside
   *     it, or a file with the same name and identical content exists there: that file is used
   *     in place, nothing is copied. This also moves a book's library entry from an older
   *     storage folder to the file in the current one.
   *  2. Re-import of a book the library already stores: its file (`existingPath`) is overwritten.
   *  3. Otherwise the file is copied into the storage folder under its original (sanitized)
   *     name; a different file with the same name gets a " (2)" suffix.
   */
  async saveBookFile(
    bookId: string,
    fileName: string,
    data: ArrayBuffer,
    existingPath?: string,
    sourcePath?: string
  ): Promise<string | undefined> {
    if (isTauriEnv() && !(await isDesktopApp())) {
      try {
        const { writeFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true })
        await writeFile(`books/${bookId}.bin`, new Uint8Array(data), {
          baseDir: BaseDirectory.AppData
        })
        return undefined
      } catch (err) {
        console.warn('[PlatformAdapter] Tauri FS fallback to IndexedDB:', err)
      }
    } else if (isTauriEnv()) {
      try {
        const { writeFile, exists } = await import('@tauri-apps/plugin-fs')
        const dir = await this.getStorageDir()
        await invokeCommand('allow_storage_dir', { path: dir })

        const inPlace = await findInStorageDir(dir, fileName, data, sourcePath)
        if (inPlace) return inPlace

        let target = existingPath && (await exists(existingPath)) ? existingPath : undefined
        if (!target) target = await uniqueFilePath(dir, sanitizeFileName(fileName))
        await writeFile(target, new Uint8Array(data))
        return target
      } catch (err) {
        console.warn('[PlatformAdapter] Tauri FS fallback to IndexedDB:', err)
      }
    }

    const db = await openIndexedDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, 'readwrite')
      tx.objectStore(STORE_FILES).put(data, bookId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return undefined
  }

  /**
   * Load binary book file (ArrayBuffer)
   */
  async loadBookBinary(bookId: string, storedPath?: string): Promise<ArrayBuffer | null> {
    if (isTauriEnv()) {
      const { readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
      const toBuffer = (bytes: Uint8Array) =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      if (storedPath) {
        try {
          return toBuffer(await readFile(storedPath))
        } catch (err) {
          console.warn('[PlatformAdapter] Stored book file not readable:', storedPath, err)
        }
      }
      try {
        return toBuffer(await readFile(`books/${bookId}.bin`, { baseDir: BaseDirectory.AppData }))
      } catch {
        // Fallback to IndexedDB if not in Tauri AppData
      }
    }

    const db = await openIndexedDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, 'readonly')
      const req = tx.objectStore(STORE_FILES).get(bookId)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  }

  /**
   * Delete binary book file from local cache
   */
  async removeBookBinary(bookId: string, storedPath?: string): Promise<void> {
    if (isTauriEnv()) {
      const { remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')
      if (storedPath) {
        try {
          await remove(storedPath)
        } catch {
          // Ignore if not found
        }
      }
      try {
        await remove(`books/${bookId}.bin`, { baseDir: BaseDirectory.AppData })
      } catch {
        // Ignore if not found
      }
    }

    const db = await openIndexedDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, 'readwrite')
      tx.objectStore(STORE_FILES).delete(bookId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /**
   * Save structured JSON metadata / settings / reading positions
   */
  async setItem<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value)
    try {
      localStorage.setItem(`easyviewer:${key}`, serialized)
    } catch {
      // Quota fallback to IndexedDB
    }

    const db = await openIndexedDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite')
      tx.objectStore(STORE_KV).put(serialized, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /**
   * Load structured JSON metadata / settings / reading positions
   */
  async getItem<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const raw = localStorage.getItem(`easyviewer:${key}`)
      if (raw !== null) {
        return JSON.parse(raw) as T
      }
    } catch {
      // Fallback to IndexedDB
    }

    try {
      const db = await openIndexedDB()
      const rawFromDb = await new Promise<string | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_KV, 'readonly')
        const req = tx.objectStore(STORE_KV).get(key)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      if (rawFromDb) {
        return JSON.parse(rawFromDb) as T
      }
    } catch {
      // Return default
    }

    return defaultValue
  }
}

export const platformStorage = new PlatformStorageAdapter()

