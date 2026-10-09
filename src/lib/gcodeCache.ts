import type { ParseGCodeOptions, WorkOffset } from './gcode'
import { controllerFilesystem } from './controllerFiles'

export interface CachedGCode {
  path: string
  fileName: string
  text: string
  parseOptions: ParseGCodeOptions
}

const DATABASE = 'fluidui-gcode'
const STORE = 'files'

function fileKey(path: string) {
  const fs = controllerFilesystem(path)
  const relative = path.replace(/\\/g, '/').replace(/^\/+/, '')
    .replace(/^(?:sd|localfs|spiffs|littlefs)(?:\/|$)/i, '').replace(/\/{2,}/g, '/')
  return `${fs}:${fs === 'sd' ? relative.toLowerCase() : relative}`
}

function validOffset(value: unknown): value is WorkOffset {
  const offset = value as WorkOffset | null
  return !!offset && [offset.x, offset.y, offset.z].every(Number.isFinite)
}

function validFile(value: unknown): value is CachedGCode {
  const file = value as CachedGCode | null
  if (!file || typeof file.path !== 'string' || typeof file.fileName !== 'string'
    || typeof file.text !== 'string' || !file.parseOptions || typeof file.parseOptions !== 'object') return false
  const { activeWcs, currentWco, workOffsets } = file.parseOptions
  const validWcs = (wcs: string) => typeof wcs === 'string' && /^G5[4-9]$|^G59\.[123]$/.test(wcs)
  return (activeWcs === undefined || validWcs(activeWcs))
    && (currentWco === undefined || validOffset(currentWco))
    && (workOffsets === undefined || (!!workOffsets && typeof workOffsets === 'object'
      && Object.entries(workOffsets).every(([wcs, offset]) => validWcs(wcs) && validOffset(offset))))
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false
    const finish = (db: IDBDatabase | null) => {
      if (settled) { db?.close(); return }
      settled = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => finish(null), 2000)
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => finish(request.result)
      request.onerror = request.onblocked = () => finish(null)
    } catch { finish(null) }
  })
}

async function accessCache<T>(
  mode: IDBTransactionMode,
  fallback: T,
  action: (store: IDBObjectStore, result: (value: T) => void) => void,
  retainResultOnError = false,
): Promise<T> {
  const db = await openDatabase()
  if (!db) return fallback
  try {
    return await new Promise<T>(resolve => {
      let value = fallback
      const tx = db.transaction(STORE, mode)
      tx.oncomplete = () => resolve(value)
      tx.onabort = () => resolve(retainResultOnError ? value : fallback)
      action(tx.objectStore(STORE), next => { value = next })
    })
  } catch { return fallback }
  finally { db.close() }
}

export async function cachePreparedGCode(controller: string, file: CachedGCode): Promise<void> {
  const saved = await accessCache('readwrite', false, (store, result) => {
    store.put(file, [controller, 'preview'])
    result(true)
  })
  if (!saved) await invalidateCachedGCode(controller, file.path)
}

/** Keep at most the prepared file and the last running file per controller. */
export async function getCachedRunningGCode(controller: string, path: string): Promise<CachedGCode | null> {
  return accessCache<CachedGCode | null>('readwrite', null, (store, result) => {
    const preview = store.get([controller, 'preview'])
    const job = store.get([controller, 'job'])
    job.onsuccess = () => {
      const file = [preview.result, job.result].find(value => validFile(value) && fileKey(value.path) === fileKey(path))
      if (!file) return
      result(file)
      // Read and promote in one transaction so a concurrent invalidation
      // cannot be undone by an older restore. A quota error still allows reads.
      store.put(file, [controller, 'job'])
    }
  }, true)
}

/** Drop saved copies when this UI edits, replaces, renames, or deletes a file. */
export async function invalidateCachedGCode(controller: string, path: string, directory = false): Promise<void> {
  await accessCache('readwrite', false, (store, result) => {
    for (const slot of ['preview', 'job']) {
      const key = [controller, slot]
      const request = store.get(key)
      request.onsuccess = () => {
        const file = request.result
        if (!validFile(file)) return
        const target = fileKey(path).replace(/\/+$/, '')
        const saved = fileKey(file.path)
        if (saved === target || (directory && saved.startsWith(target.endsWith(':') ? target : `${target}/`))) store.delete(key)
      }
    }
    result(true)
  })
}
