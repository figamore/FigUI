import assert from 'node:assert/strict'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

Object.assign(globalThis, {
  document: Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } } }),
  window: Object.assign(new EventTarget(), { location: { protocol: 'http:', pathname: '/' } }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })

const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
const delay = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms))
/** Runs fn with every timer 1000 times faster, so a 15 s limit takes 15 ms. */
async function withFastTimers<T>(fn: () => Promise<T>): Promise<T> {
  Object.assign(globalThis, {
    setTimeout: (callback: () => void, ms = 0) => realSetTimeout(callback, ms / 1000),
    setInterval: (callback: () => void, ms = 0) => realSetInterval(callback, ms / 1000),
  })
  try { return await fn() } finally { Object.assign(globalThis, { setTimeout: realSetTimeout, setInterval: realSetInterval }) }
}

// Every file request in order: "<action> <filename>[ -> newname]" or "upload <name>".
let log: string[] = []
let fileOp: (params: URLSearchParams) => string | Error = () => '{"status":"Ok"}'
let reply: ((url: URL, init?: RequestInit) => Response | Promise<Response>) | null = null

// The files of the one folder the save cases use.
let folder = new Set<string>()
const listing = (status: string) => JSON.stringify({
  files: [...folder].map(name => ({ name, size: '1' })), path: '/', total: '1 MB', used: '0 B', occupation: '0', status,
})

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (reply) return reply(url, init)
  const action = url.searchParams.get('action')
  if (!action) return new Response(listing('Ok'))
  const name = url.searchParams.get('filename')
  const newname = url.searchParams.get('newname')
  log.push(`${action} ${name}${newname ? ` -> ${newname}` : ''}`)
  const result = fileOp(url.searchParams)
  if (result instanceof Error) throw result
  return new Response(result)
}) as typeof fetch

let xhrReply = '{"status":"Ok"}'
let xhrStalls = false
let lastXhr: FakeXhr | null = null
class FakeXhr {
  upload: Record<string, ((event?: unknown) => void) | null> = {}
  status = 200
  responseText = ''
  timeout = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open() {}
  abort() { queueMicrotask(() => this.onabort?.()) }
  send(fd: FormData) {
    const name = (fd.get('myfile[]') as File).name
    log.push(`upload ${name}`)
    folder.add(name.slice(name.lastIndexOf('/') + 1))
    lastXhr = this
    this.responseText = xhrReply
    if (!xhrStalls) queueMicrotask(() => this.onload?.())
  }
}
Object.assign(globalThis, { XMLHttpRequest: FakeXhr })

const http = await import('../src/lib/http')
http.setBase('http://fluidnc.test')

// ── File actions: a failure FluidNC reports with status 200 is an error ──────
fileOp = () => listing('a.nc deleted')
await http.deleteFile('/sd/', 'a.nc')
fileOp = () => listing('Cannot delete a.nc Permission denied')
await assert.rejects(http.deleteFile('/sd/', 'a.nc'), /Cannot delete a\.nc/)
fileOp = () => listing('Cannot rename a.nc File exists')
await assert.rejects(http.renameFile('/sd/', 'a.nc', 'b.nc'), /Cannot rename/)
fileOp = () => '{"status":"No SD card"}'
await assert.rejects(http.createDir('/sd/', 'jobs'), /No SD card/)
// Success statuses start with the file name, which may itself look like a failure.
fileOp = () => listing('error.nc deleted')
await http.deleteFile('/sd/', 'error.nc')
fileOp = () => listing('Cannot.nc renamed to x.nc')
await http.renameFile('/sd/', 'Cannot.nc', 'x.nc')
fileOp = () => listing('Error-test created')
await http.createDir('/sd/', 'Error-test')
fileOp = () => listing('Missing parts deleted')
await http.deleteDir('/sd/', 'Missing parts')
fileOp = () => listing('Ok')
await http.createDir('/', 'plugins', 'local')
assert.deepEqual((await http.listFiles('/sd/')).files, [])
fileOp = () => '{"status":"Ok"}'

// ── Saves: the new content goes to a temporary name and is renamed over ──────
// Like FAT and SPIFFS, the folder refuses to rename onto an existing file.
// fail(from, to) can make one rename fail, before (lost) or after (done) it.
const folderOp = (fail?: (from: string, to: string) => { error: string | Error; done?: boolean } | undefined) =>
  (params: URLSearchParams) => {
    const action = params.get('action')
    const name = params.get('filename')!
    const to = params.get('newname')!
    if (action === 'delete') folder.delete(name)
    if (action !== 'rename') return '{"status":"Ok"}'
    const failure = fail?.(name, to)
    if (failure && !failure.done) return failure.error
    if (!folder.has(name) || folder.has(to)) return `{"status":"Cannot rename ${name}"}`
    folder.delete(name)
    folder.add(to)
    return failure?.error ?? '{"status":"Ok"}'
  }

// A new file is renamed into place.
folder = new Set()
log = []
fileOp = folderOp()
await http.replaceFileContent('/', 'config.yaml', 'name: A\n', 'local')
assert.deepEqual(log, ['upload /config.yaml.new', 'rename config.yaml.new -> config.yaml'])
assert.deepEqual([...folder], ['config.yaml'])

// Over an existing file, the original is kept as .bak until the new one is in place.
log = []
await http.replaceFileContent('/', 'config.yaml', 'name: B\n', 'local')
assert.deepEqual(log, [
  'upload /config.yaml.new',
  'rename config.yaml.new -> config.yaml',
  'rename config.yaml -> config.yaml.bak',
  'rename config.yaml.new -> config.yaml',
  'delete config.yaml.bak',
])
assert.deepEqual([...folder].sort(), ['config.yaml'])

// If the new file cannot take its place, the original is put back.
log = []
let attempts = 0
fileOp = folderOp((from, to) => from === 'config.yaml.new' && to === 'config.yaml' && ++attempts === 2
  ? { error: '{"status":"Cannot rename config.yaml.new: card error"}' } : undefined)
await assert.rejects(http.replaceFileContent('/', 'config.yaml', 'name: C\n', 'local'), /card error/)
assert.deepEqual(log.slice(-2), ['rename config.yaml.new -> config.yaml', 'rename config.yaml.bak -> config.yaml'])
assert.deepEqual([...folder].sort(), ['config.yaml', 'config.yaml.new'])

// A lost reply after the rename happened: the save is done, nothing is deleted.
folder = new Set(['config.yaml.bak'])
log = []
fileOp = folderOp(() => ({ error: new TypeError('Failed to fetch'), done: true }))
await http.replaceFileContent('/', 'config.yaml', 'name: D\n', 'local')
assert.deepEqual(log, ['upload /config.yaml.new', 'rename config.yaml.new -> config.yaml'])
assert.deepEqual([...folder].sort(), ['config.yaml', 'config.yaml.bak'])

// A failure that is not the target existing leaves everything as it was.
folder = new Set()
log = []
fileOp = folderOp(() => ({ error: new TypeError('Failed to fetch') }))
await assert.rejects(http.replaceFileContent('/', 'config.yaml', 'name: E\n', 'local'), /Failed to fetch/)
assert.deepEqual(log, ['upload /config.yaml.new', 'rename config.yaml.new -> config.yaml'])

// A backup left by an earlier save may be the only copy of the original.
folder = new Set(['config.yaml', 'config.yaml.bak'])
log = []
fileOp = folderOp()
await assert.rejects(http.replaceFileContent('/', 'config.yaml', 'name: F\n', 'local'), /config\.yaml\.bak is left/)
assert.deepEqual([...folder].sort(), ['config.yaml', 'config.yaml.bak', 'config.yaml.new'])
folder = new Set()
fileOp = () => '{"status":"Ok"}'

// Saving an edited file whose name looks like a failure status.
fileOp = () => listing('error.nc.new renamed to error.nc')
await http.replaceFileContent('/sd/', 'error.nc', 'G0 X1\n', 'sd')
fileOp = () => '{"status":"Ok"}'

// ── Firmware update: FluidNC answers 200 and reports the result in status ────
const image = new File(['x'], 'firmware.bin')
xhrReply = '{"status":"3"}'
await http.uploadFirmware(image)
xhrReply = '{"status":"1"}'
await assert.rejects(http.uploadFirmware(image), /rejected the firmware image/)
xhrReply = ''
await http.uploadFirmware(image)
xhrReply = '{"status":"Ok"}'

// ── Uploads give up only once no data has moved for 30 s ─────────────────────
const realNow = Date.now
xhrStalls = true
await withFastTimers(async () => {
  let clock = 0
  Date.now = () => realNow() + clock
  let settled = false
  const upload = http.uploadFile('/sd/', new File(['G0 X1\n'], 'slow.nc'), 'sd')
  upload.catch(() => {}).finally(() => { settled = true })
  await delay(20)
  clock = 20_000
  lastXhr!.upload.onprogress?.({ lengthComputable: false })
  clock = 45_000
  await delay(20)
  assert.equal(settled, false, 'an upload whose data keeps moving goes on')
  clock = 51_000
  await assert.rejects(upload, /Upload stalled: no data moved for 30 s/)
})
Date.now = realNow
xhrStalls = false

// ── Requests that never answer do not hold the queues ────────────────────────
const hang = (_url: URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
})
reply = hang
await withFastTimers(() => assert.rejects(http.sendCommand('$I'), /HTTP timeout/))
await withFastTimers(() => assert.rejects(http.fetchFileContent('/sd/a.nc'), /HTTP timeout/))

// A file stalled mid-transfer gives up; a slow one that keeps arriving does not.
const fileBytes = new TextEncoder().encode('G0 X1 ; ölçü\n')
const chunked = (stallAfterFirst: boolean) => (_url: URL, init?: RequestInit) => new Response(new ReadableStream({
  async start(stream) {
    init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')))
    // One byte every 5 ms takes far longer than the (sped-up) 20 ms limit.
    for (let i = 0; i < fileBytes.length; i++) {
      stream.enqueue(fileBytes.slice(i, i + 1))
      if (stallAfterFirst) return
      await delay(5)
    }
    stream.close()
  },
}))
reply = chunked(true)
await withFastTimers(() => assert.rejects(http.fetchFileContent('/sd/a.nc'), /HTTP timeout/))
reply = chunked(false)
// A character split between two chunks survives.
assert.equal(await withFastTimers(() => http.fetchFileContent('/sd/a.nc')), 'G0 X1 ; ölçü\n')

// ── The preview asks for work offsets only when the program selects one ─────
Object.assign(globalThis, { Path2D: class { moveTo() {} lineTo() {} } })
const { useMachineStore } = await import('../src/store')
const { useGCodeStore } = await import('../src/store/gcode')
useMachineStore.setState(state => ({ connected: true, statusReceived: true, status: { ...state.status, state: 'Idle' } }))
const commands: string[] = []
reply = url => {
  commands.push(url.searchParams.get('plain') ?? url.pathname)
  return new Response('[G55:10,0,0]\nok\n')
}
await useGCodeStore.getState().loadFromText('G0 X1\nG1 X2 F100\n', 'plain.nc')
assert.deepEqual(commands, [], 'no $# for a program that never selects G54-G59')
await useGCodeStore.getState().loadFromText('G55\nG0 X1\n', 'g55.nc')
assert.deepEqual(commands, ['$#'])
// A $# that never answers holds the preview for 3 s at most.
commands.length = 0
reply = (url, init) => {
  commands.push(url.searchParams.get('plain') ?? url.pathname)
  return hang(url, init)
}
const warn = console.warn
console.warn = () => {} // the preview reports the missing offsets
await withFastTimers(() => useGCodeStore.getState().loadFromText('G56\nG0 X3\n', 'g56.nc'))
console.warn = warn
assert.deepEqual(commands, ['$#'])
assert.equal(useGCodeStore.getState().fileName, 'g56.nc', 'the preview is built without the offsets')
reply = null

console.log('HTTP file tests passed')
