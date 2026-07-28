import { getPageId } from './ws'
import type { FileListResult, Macro } from '../types'

let base = ''
export const setBase = (url: string) => { base = url.replace(/\/$/, '') }
export const getBase = () => base

let httpChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = httpChain.then(fn, fn)
  httpChain = next.catch(() => {})
  return next
}

function fsEndpoint(fs: 'sd' | 'local') {
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

function get(path: string, params: Record<string, string>, timeoutMs?: number): Promise<string> {
  return serialize(async () => {
    const q = new URLSearchParams({ ...params, PAGEID: getPageId() })
    const ctl = timeoutMs ? new AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
    try {
      const res = await fetch(`${base}${path}?${q}`, ctl ? { signal: ctl.signal } : undefined)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      if (ctl?.signal.aborted) throw new Error('HTTP timeout')
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
}

export const sendCommand = (cmd: string) =>
  get('/command', { plain: cmd })

export const sendSilent = (cmd: string) =>
  get('/command_silent', { plain: cmd })

export const getDeviceInfoFast = () =>
  get('/command', { plain: '[ESP800]json=yes' }, 4000)

export function listFiles(path: string, fs: 'sd' | 'local' = 'sd'): Promise<FileListResult> {
  return serialize(async () => {
    const apiPath = fs === 'sd' ? sdRelPath(path) : path
    const res = await fetch(`${base}${fsEndpoint(fs)}?${new URLSearchParams({ path: apiPath })}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.json()
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
  })
}

export async function deleteFile(path: string, filename: string, fs: 'sd' | 'local' = 'sd'): Promise<void> {
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await get(fsEndpoint(fs), { path: apiPath, action: 'delete', filename })
}

export async function deleteDir(path: string, filename: string, fs: 'sd' | 'local' = 'sd'): Promise<void> {
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await get(fsEndpoint(fs), { path: apiPath, action: 'deletedir', filename })
}

export async function createDir(path: string, filename: string, fs: 'sd' | 'local' = 'sd'): Promise<void> {
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await get(fsEndpoint(fs), { path: apiPath, action: 'createdir', filename })
}

export async function renameFile(path: string, filename: string, newname: string, fs: 'sd' | 'local' = 'sd'): Promise<void> {
  const apiPath = fs === 'sd' ? sdRelPath(path) : path
  await get(fsEndpoint(fs), { path: apiPath, action: 'rename', filename, newname })
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

async function checkFreeSpace(fs: 'sd' | 'local', bytes: number, dir: string, filename: string): Promise<void> {
  if (fs !== 'local') return
  try {
    const info = await listFiles(dir, fs)
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

export async function uploadFile(
  path: string,
  file: File,
  fs: 'sd' | 'local',
  onProgress?: (pct: number) => void,
  onPhase?: (phase: 'preparing' | 'uploading' | 'finishing') => void,
): Promise<void> {
  onPhase?.('preparing')
  await checkFreeSpace(fs, file.size, path, file.name)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const fd = new FormData()
    const rawPath = fs === 'sd' ? sdRelPath(path) : path
    const apiPath = normalizeUploadDirPath(rawPath)

    const fullPath = joinUploadPath(apiPath, file.name)
    fd.append('path', apiPath)
    fd.append(`${fullPath}S`, String(file.size))
    fd.append('myfile[]', file, fullPath)

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.upload.onloadstart = () => onPhase?.('uploading')
    xhr.upload.onload = () => onPhase?.('finishing')

    xhr.onload = () => {
      if (xhr.status >= 300) {
        reject(new Error(`Upload ${xhr.status}`))
        return
      }
      const statusError = uploadStatusError(xhr.responseText)
      statusError ? reject(new Error(statusError)) : resolve()
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.open('POST', `${base}${fsEndpoint(fs)}`)
    xhr.send(fd)
  })
}

export function fetchFileContent(fullPath: string, fs: 'sd' | 'local' = 'sd'): Promise<string> {
  return serialize(async () => {
    const mountedPath = fs === 'sd' && !/^\/sd(?:\/|$)/.test(fullPath)
      ? `/sd${fullPath.startsWith('/') ? '' : '/'}${fullPath}`
      : fullPath
    const url = `${base}${mountedPath}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  })
}

export async function saveFileContent(
  path: string,
  filename: string,
  content: string,
  fs: 'sd' | 'local',
): Promise<void> {
  const blob = new Blob([content], { type: 'application/octet-stream' })
  const file = new File([blob], filename)
  await uploadFile(path, file, fs)
}

export const getDeviceInfo = () => sendCommand('[ESP800]json=yes')

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

    xhr.onload    = () => settle(() => xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)))
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

export async function loadMacroCfg(): Promise<Macro[]> {
  try {
    const text = await fetchFileContent(MACRO_CFG, 'local')
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
  await saveFileContent('/', 'macrocfg.json', JSON.stringify(config, null, 1), 'local')
}
