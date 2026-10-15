import { getPageId } from './ws'
import { invalidateCachedGCode } from './gcodeCache'
import type { FileListResult, Macro } from '../types'

let base = ''
export const setBase = (url: string) => { base = url.replace(/\/$/, '') }
export const getBase = () => base

/**
 * Detect FigUI's /ui/<name>/ directory for its state files and updates.
 * Returns null outside that route, preserving shared LocalFS storage.
 * Commands and the WebSocket still use the independent session and PAGEID.
 */
export const uiDir: string | null = (() => {
  const m = /^\/ui\/[^/]+\//.exec(window.location.pathname)
  return m ? m[0] : null
})()

/** Read a file from FigUI's own /ui/<name>/ directory */
async function fetchUiFile(name: string): Promise<string> {
  const res = await fetch(`${base}${uiDir}${name}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * Write a file into FigUI's own /ui/<name>/ directory.  FluidNC takes the
 * request body as the file contents (no multipart form), writes it under a
 * temporary name, and renames it when complete.  It answers 201 or 204, or
 * 503 while the machine is moving.
 */
export function putUiFile(name: string, data: Blob, onProgress?: (pct: number) => void): Promise<void> {
  return serializeFilesystem('local', () => new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else if (xhr.status === 503) reject(new Error('Cannot save while the machine is moving'))
      else reject(new Error(`Upload ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))
    xhr.timeout = Math.max(120_000, Math.ceil(data.size / 65_536) * 1_000)
    xhr.open('PUT', `${base}${uiDir}${name}`)
    xhr.send(data)
  }))
}

export class WebUIBlockedError extends Error {
  constructor() {
    super('Cannot load WebUI while GCode Program is Running')
    this.name = 'WebUIBlockedError'
  }
}

let httpChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = httpChain.then(fn, fn)
  httpChain = next.catch(() => {})
  return next
}

type Filesystem = 'sd' | 'local'

const filesystemChains: Record<Filesystem, Promise<unknown>> = {
  sd: Promise.resolve(),
  local: Promise.resolve(),
}

function serializeFilesystem<T>(fs: Filesystem, fn: () => Promise<T>): Promise<T> {
  const next = filesystemChains[fs].then(fn, fn)
  filesystemChains[fs] = next.catch(() => {})
  return next
}

// File requests run one at a time, so a reply that stops arriving (a bad
// card, a controller reset, WiFi dropping mid-request) must not hold every
// later file action. The timer restarts on each received chunk, so a large
// preview on a slow link is not cut off.
const FILESYSTEM_STALL_TIMEOUT_MS = 20_000

async function fetchFilesystemText(url: string): Promise<string> {
  const ctl = new AbortController()
  let timer = setTimeout(() => ctl.abort(), FILESYSTEM_STALL_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) return await res.text()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      clearTimeout(timer)
      timer = setTimeout(() => ctl.abort(), FILESYSTEM_STALL_TIMEOUT_MS)
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      text += decoder.decode(value, { stream: true })
    }
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('HTTP timeout')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function fsEndpoint(fs: Filesystem) {
  return fs === 'sd' ? '/upload' : '/files'
}

function normalizeUploadDirPath(p: string): string {
  if (!p) return '/'
  if (p === '/') return '/'
  return p.endsWith('/') ? p : `${p}/`
}

function joinUploadPath(dir: string, filename: string): string {
  if (dir === '/') return `/${filename}`
  const normalizedDir = normalizeUploadDirPath(dir)
  return `${normalizedDir}${filename}`
}

/** Strip the SD VFS mount prefix (e.g. /sd/) so the /upload API gets a card-relative path */
function sdRelPath(p: string): string {
  return p.replace(/^\/sd\b/, '') || '/'
}

/** Parse a size value that may be "1536 KB", "1.5 MB", or a plain number (bytes). */
function parseSize(val: unknown): number {
  if (val == null) return 0
  const s = String(val).trim()
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = (m[2] ?? 'B').toUpperCase()
  const mul: Record<string, number> = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }
  return Math.round(n * (mul[unit] ?? 1))
}

// Requests run one at a time, so a reply that never arrives (the controller
// reset or WiFi dropped mid-request) must not hold every later command,
// including the reconnect's [ESP800], until TCP gives up.
const DEFAULT_HTTP_TIMEOUT_MS = 15_000

function get(path: string, params: Record<string, string>, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<string> {
  return serialize(async () => {
    const q = new URLSearchParams({ ...params, PAGEID: getPageId() })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}?${q}`, {
        cache: 'no-store',
        signal: ctl.signal,
      })
      if (!res.ok) {
        // FluidNC blocks synchronous HTTP during motion, even if the browser
        // has already loaded a cached copy of the WebUI.
        if (res.status === 503) {
          const body = await res.text()
          if (/Try again when not moving|Cannot load WebUI while GCode Program is Running/i.test(body)) {
            throw new WebUIBlockedError()
          }
        }
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.text()
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('HTTP timeout')
      throw e
    } finally {
      clearTimeout(timer)
    }
  })
}

export const sendCommand = (cmd: string, timeoutMs?: number) =>
  get('/command', { plain: cmd }, timeoutMs)

export async function sendBlockMode(enabled: boolean, signal: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ plain: `$GB=${enabled ? 'On' : 'Off'}`, PAGEID: getPageId() })
  const response = await fetch(`${base}/command?${params}`, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

export const sendSilent = (cmd: string) =>
  get('/command_silent', { plain: cmd })

export const getDeviceInfoFast = () =>
  get('/command', { cmd: '[ESP800]json=yes' }, 4000)

async function listFilesRequest(path: string, fs: Filesystem): Promise<FileListResult> {
    const apiPath = fs === 'sd' ? sdRelPath(path) : path
    const raw = JSON.parse(await fetchFilesystemText(`${base}${fsEndpoint(fs)}?${new URLSearchParams({ path: apiPath })}`))
    return {
      files: (raw.files ?? []).map((f: { name: string; size: string }) => ({
        name:  f.name,
        size:  Math.max(0, Number(f.size) || 0),
        isDir: f.size === '-1',
      })),
      path:       raw.path  ?? apiPath,
      total:      parseSize(raw.total),
      used:       parseSize(raw.used),
      occupation: Number(raw.occupation) || 0,
    }
}

export function listFiles(path: string, fs: Filesystem = 'sd'): Promise<FileListResult> {
  return serializeFilesystem(fs, () => listFilesRequest(path, fs))
}

async function filesystemGet(path: string, params: Record<string, string>): Promise<string> {
  const q = new URLSearchParams({ ...params, PAGEID: getPageId() })
  const text = await fetchFilesystemText(`${base}${path}?${q}`)
  // FluidNC answers 200 even when the action failed and puts the reason in
  // the JSON status ("Cannot delete …", "Cannot rename …", "No SD card").
  // Success statuses start with the file name ("error.nc deleted"), so the
  // exact success text is checked first.
  const status = uploadStatusError(text)
  const { action, filename, newname } = params
  const success = action === 'rename' ? `${filename} renamed to ${newname}`
    : action === 'createdir' ? `${filename} created` : `${filename} deleted`
  if (status && status !== success && /^(cannot|no sd|missing|error)\b/i.test(status)) throw new Error(status)
  return text
}

export async function deleteFile(path: string, filename: string, fs: Filesystem = 'sd'): Promise<void> {
  const controller = base
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await serializeFilesystem(fs, () => filesystemGet(fsEndpoint(fs), { path: apiPath, action: 'delete', filename }))
  await invalidateCachedGCode(controller, mountedFilePath(joinUploadPath(path, filename), fs))
}

export async function deleteDir(path: string, filename: string, fs: Filesystem = 'sd'): Promise<void> {
  const controller = base
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await serializeFilesystem(fs, () => filesystemGet(fsEndpoint(fs), { path: apiPath, action: 'deletedir', filename }))
  await invalidateCachedGCode(controller, mountedFilePath(joinUploadPath(path, filename), fs), true)
}

export async function createDir(path: string, filename: string, fs: Filesystem = 'sd'): Promise<void> {
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await serializeFilesystem(fs, () => filesystemGet(fsEndpoint(fs), { path: apiPath, action: 'createdir', filename }))
}

export async function renameFile(path: string, filename: string, newname: string, fs: Filesystem = 'sd'): Promise<void> {
  const controller = base
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await serializeFilesystem(fs, () => filesystemGet(fsEndpoint(fs), { path: apiPath, action: 'rename', filename, newname }))
  await invalidateCachedGCode(controller, mountedFilePath(joinUploadPath(path, filename), fs), true)
  await invalidateCachedGCode(controller, mountedFilePath(joinUploadPath(path, newname), fs), true)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function uploadStatusError(text: string): string | null {
  if (!text.trim()) return null
  try {
    const data = JSON.parse(text)
    const status = typeof data?.status === 'string' ? data.status.trim() : ''
    if (!status || /^ok$/i.test(status)) return null
    return status
  } catch {
    return null
  }
}

async function checkFreeSpace(fs: Filesystem, bytes: number, dir: string, filename: string): Promise<void> {
  if (fs !== 'local') return
  try {
    const info = await listFilesRequest(dir, fs)
    if (!info.total) return
    const available = Math.max(0, info.total - info.used)
    const existing = info.files.find(entry => !entry.isDir && entry.name === filename)
    const netBytes = Math.max(0, bytes - (existing?.size ?? 0))
    if (netBytes > available) {
      throw new Error(
        `Not enough space on Internal storage: ` +
        `need ${fmtBytes(netBytes)}, only ${fmtBytes(available)} free`
      )
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Not enough')) throw e
  }
}

const UPLOAD_STALL_TIMEOUT_MS = 30_000

export function uploadFile(
  path: string,
  file: File,
  fs: Filesystem,
  onProgress?: (pct: number) => void,
  onPhase?: (phase: 'preparing' | 'uploading' | 'finishing') => void,
): Promise<void> {
  onPhase?.('preparing')
  const controller = base
  return serializeFilesystem(fs, async () => {
    await checkFreeSpace(fs, file.size, path, file.name)
    // A failed transfer can also replace or truncate an existing file.
    await invalidateCachedGCode(controller, mountedFilePath(joinUploadPath(path, file.name), fs))
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const fd = new FormData()
      const rawPath = fs === 'sd' ? sdRelPath(path) : path
      const apiPath = normalizeUploadDirPath(rawPath)

      const fullPath = joinUploadPath(apiPath, file.name)
      fd.append('path', apiPath)
      fd.append(`${fullPath}S`, String(file.size))
      fd.append('myfile[]', file, fullPath)

      // A weak link, or a card shared with a running job, can need far longer
      // than any fixed limit, and FluidNC deletes the partial file when the
      // upload is cut off. Give up only once no data has moved for a while.
      let lastMoveAt = Date.now()
      let stalled = false
      const stallTimer = setInterval(() => {
        if (Date.now() - lastMoveAt <= UPLOAD_STALL_TIMEOUT_MS) return
        clearInterval(stallTimer)
        stalled = true
        xhr.abort()
      }, 5_000)
      const finish = (error?: Error) => {
        clearInterval(stallTimer)
        error ? reject(error) : resolve()
      }

      xhr.upload.onprogress = e => {
        lastMoveAt = Date.now()
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.upload.onloadstart = () => onPhase?.('uploading')
      xhr.upload.onload = () => {
        lastMoveAt = Date.now()
        onPhase?.('finishing')
      }

      xhr.onload = () => {
        if (xhr.status >= 300) {
          finish(new Error(`Upload ${xhr.status}`))
          return
        }
        const statusError = uploadStatusError(xhr.responseText)
        finish(statusError ? new Error(statusError) : undefined)
      }
      xhr.onerror = () => finish(new Error('Upload failed'))
      xhr.onabort = () => finish(new Error(stalled
        ? `Upload stalled: no data moved for ${UPLOAD_STALL_TIMEOUT_MS / 1000} s`
        : 'Upload cancelled'))
      xhr.open('POST', `${base}${fsEndpoint(fs)}`)
      xhr.send(fd)
    })
  })
}

function mountedFilePath(fullPath: string, fs: Filesystem): string {
  return fs === 'sd' && !/^\/sd(?:\/|$)/.test(fullPath)
    ? `/sd${fullPath.startsWith('/') ? '' : '/'}${fullPath}`
    : fullPath
}

export function fetchFileContent(fullPath: string, fs: Filesystem = 'sd'): Promise<string> {
  return serializeFilesystem(fs, () =>
    fetchFilesystemText(`${base}${mountedFilePath(fullPath, fs)}`))
}

export function downloadFile(fullPath: string, filename: string, fs: Filesystem): Promise<void> {

  return (async () => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 120_000)
    let objectUrl: string | null = null

    try {
      const res = await fetch(`${base}${mountedFilePath(fullPath, fs)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Download failed (${res.status})`)

      objectUrl = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (error) {
      if (timedOut) throw new Error('Download timed out')
      throw error
    } finally {
      clearTimeout(timer)
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 0)
    }
  })()
}

export async function saveFileContent(
  path: string,
  filename: string,
  content: string,
  fs: Filesystem,
): Promise<void> {
  const blob = new Blob([content], { type: 'application/octet-stream' })
  const file = new File([blob], filename)
  await uploadFile(path, file, fs)
}

/**
 * Like saveFileContent, but the old file stays until the new one is complete:
 * FluidNC empties an upload target at once and deletes it if the connection
 * drops, so the content goes to a temporary name and is renamed over it.
 */
export async function replaceFileContent(
  path: string,
  filename: string,
  content: string,
  fs: Filesystem,
): Promise<void> {
  const temporary = `${filename}.new`
  await saveFileContent(path, temporary, content, fs)
  try {
    await renameFile(path, temporary, filename, fs)
  } catch (e) {
    // FAT and SPIFFS refuse to rename onto an existing file. Anything else,
    // such as a lost reply, may mean the rename already happened.
    if (!(e instanceof Error && /^cannot rename/i.test(e.message))) throw e
    await deleteFile(path, filename, fs)
    await renameFile(path, temporary, filename, fs)
  }
}

// FluidNC's cmd path explicitly allows ESP800 during motion. The plain path
// blocks every synchronous command, including discovery.
export const getDeviceInfo = () => get('/command', { cmd: '[ESP800]json=yes' }, 4000)

export function uploadFirmware(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const fd = new FormData()
    fd.append(`/${file.name}S`, String(file.size))
    fd.append('myfile[]', file, `/${file.name}`)

    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearInterval(stallTimer)
      fn()
    }

    let lastLoaded = 0
    let lastMoveTime = Date.now()
    const stallTimer = setInterval(() => {
      if (Date.now() - lastMoveTime > 30_000)
        settle(() => { xhr.abort(); reject(new Error('Upload stalled — no progress for 30 s. The device may be busy; try again.')) })
    }, 5_000)

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          if (e.loaded !== lastLoaded) { lastLoaded = e.loaded; lastMoveTime = Date.now() }
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
    }

    // FluidNC answers 200 even when it rejected the image (wrong chip, image
    // too large) and puts the result in the JSON status: "3" means flashed,
    // any other number means the old firmware is still running.
    xhr.onload    = () => settle(() => {
      if (xhr.status >= 300) return reject(new Error(`Upload failed (${xhr.status})`))
      const status = uploadStatusError(xhr.responseText)
      if (status && /^\d+$/.test(status) && status !== '3')
        return reject(new Error('The controller rejected the firmware image; the current firmware is still running.'))
      resolve()
    })
    xhr.onerror   = () => settle(() => reject(new Error('Upload failed')))
    xhr.ontimeout = () => settle(() => reject(new Error('Upload timed out')))
    xhr.onabort   = () => settle(() => {})
    xhr.timeout   = 120_000
    xhr.open('POST', `${base}/updatefw`)
    xhr.send(fd)
  })
}

const MACRO_CFG = '/macrocfg.json'

function colorToClass(color: Macro['color']): string {
  switch (color) {
    case 'danger': return 'btn btn-danger'
    case 'warn': return 'btn btn-warning'
    case 'ok': return 'btn btn-success'
    case 'info': return 'btn btn-info'
    case 'purple': return 'btn btn-purple'
    case 'teal': return 'btn btn-teal'
    case 'accent': return 'btn btn-primary'
    default: return 'btn-default'
  }
}

function classToColor(klass: string): Macro['color'] {
  const c = (klass || '').toLowerCase()
  if (c.includes('danger')) return 'danger'
  if (c.includes('warning') || c.includes('warn')) return 'warn'
  if (c.includes('success') || c.includes('ok')) return 'ok'
  if (c.includes('info')) return 'info'
  if (c.includes('purple')) return 'purple'
  if (c.includes('teal')) return 'teal'
  if (c.includes('primary') || c.includes('accent')) return 'accent'
  return 'default'
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asTarget(v: unknown): 'SD' | 'ESP' {
  return asString(v).toUpperCase() === 'SD' ? 'SD' : 'ESP'
}

/** Read FigUI's own macro configuration, falling back to shared LocalFS if the read fails. */
async function readMacroCfg(): Promise<string> {
  if (uiDir) {
    try {
      return await fetchUiFile('macrocfg.json')
    } catch {
      // Not saved here yet
    }
  }
  return fetchFileContent(MACRO_CFG, 'local')
}

/** Parse and normalize saved macros, returning an empty list if loading or parsing fails. */
export async function loadMacroCfg(): Promise<Macro[]> {
  try {
    const text = await readMacroCfg()
    const data = JSON.parse(text)
    if (!Array.isArray(data)) return []
    return data.map((entry: any) => ({
      id: String(entry.index ?? 0),
      label: asString(entry.name),
      command: '',
      color: classToColor(asString(entry.class)),
      filename: asString(entry.filename),
      target: asString(entry.target) ? asTarget(entry.target) : undefined,
      glyph: asString(entry.glyph),
      pinned: entry.pinned === true,
    })).filter(m => m.label || m.filename)
  } catch {
    return []
  }
}

/**
 * Save macros with at least nine slots in FigUI's own directory, or shared
 * LocalFS when served outside /ui/<name>/. Rejects if the write fails.
 */
export async function saveMacroCfg(data: Macro[]): Promise<void> {
  const slotCount = Math.max(9, data.length)
  const config = Array.from({ length: slotCount }, (_, i) => {
    const macro = data[i]
    if (!macro) {
      return {
        name: '',
        glyph: '',
        filename: '',
        target: '',
        class: '',
        index: i,
      }
    }

    return {
      name: macro.label || '',
      glyph: macro.glyph || '',
      filename: macro.filename || '',
      target: macro.target || '',
      class: colorToClass(macro.color),
      pinned: macro.pinned ?? false,
      index: i,
    }
  })
  const text = JSON.stringify(config, null, 1)
  if (uiDir) {
    await putUiFile('macrocfg.json', new Blob([text], { type: 'application/json' }))
  } else {
    await saveFileContent('/', 'macrocfg.json', text, 'local')
  }
}
