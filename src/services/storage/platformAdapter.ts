/**
 * Platform Abstraction Layer (Tauri 2 Native FS/Store + Web IndexedDB/LocalStorage Fallback)
 * Supports Windows, macOS, Android, iOS (via Tauri 2) and Web browsers seamlessly.
 */

const DB_NAME = 'EasyViewerDB'
const DB_VERSION = 1
const STORE_FILES = 'book_files'
const STORE_KV = 'key_value'

export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
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
  /**
   * Save binary book file (ArrayBuffer) for offline reading
   */
  async saveBookBinary(bookId: string, data: ArrayBuffer): Promise<void> {
    if (isTauriEnv()) {
      try {
        const { writeFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true })
        await writeFile(`books/${bookId}.bin`, new Uint8Array(data), {
          baseDir: BaseDirectory.AppData
        })
        return
      } catch (err) {
        console.warn('[PlatformAdapter] Tauri FS fallback to IndexedDB:', err)
      }
    }

    const db = await openIndexedDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, 'readwrite')
      tx.objectStore(STORE_FILES).put(data, bookId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /**
   * Load binary book file (ArrayBuffer)
   */
  async loadBookBinary(bookId: string): Promise<ArrayBuffer | null> {
    if (isTauriEnv()) {
      try {
        const { readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        const bytes = await readFile(`books/${bookId}.bin`, {
          baseDir: BaseDirectory.AppData
        })
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
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
  async removeBookBinary(bookId: string): Promise<void> {
    if (isTauriEnv()) {
      try {
        const { remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')
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

