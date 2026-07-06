/**
 * IndexedDB-backed cache for the parsed CSV payload.
 *
 * Replaces the previous localStorage cache so uploads larger than ~4 MB can
 * survive a refresh. IndexedDB's per-origin quota is measured in hundreds of
 * MB to several GB depending on the browser and free disk, versus
 * localStorage's ~5–10 MB ceiling that would silently drop oversized files.
 *
 * Surface intentionally mirrors the old localStorage helpers so the caller
 * (CsvDataContext) only had to swap sync → async:
 *   loadCache(): Promise<{ data, recentFiles } | null>
 *   saveCache(payload): Promise<void>
 *   clearCache(): Promise<void>
 *
 * All three resolve on failure rather than reject — private-browsing modes
 * and unavailable IndexedDB implementations should degrade to "no cache",
 * not crash the app. That matches the previous localStorage behavior.
 */

const DB_NAME = 'csvDataCache'
const STORE_NAME = 'kv'
const KEY = 'v1'

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('open failed'))
    req.onblocked = () => reject(new Error('open blocked'))
  })
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const store = tx.objectStore(STORE_NAME)
        let result
        tx.oncomplete = () => {
          db.close()
          resolve(result)
        }
        tx.onerror = () => {
          db.close()
          reject(tx.error ?? new Error('tx failed'))
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error ?? new Error('tx aborted'))
        }
        try {
          const req = run(store)
          if (req && 'onsuccess' in req) {
            req.onsuccess = () => { result = req.result }
          }
        } catch (err) {
          reject(err)
        }
      })
  )
}

export function loadCache() {
  return withStore('readonly', (store) => store.get(KEY))
    .then((value) => value ?? null)
    .catch(() => null)
}

export function saveCache(payload) {
  return withStore('readwrite', (store) => store.put(payload, KEY))
    .then(() => undefined)
    .catch(() => undefined)
}

export function clearCache() {
  return withStore('readwrite', (store) => store.delete(KEY))
    .then(() => undefined)
    .catch(() => undefined)
}
