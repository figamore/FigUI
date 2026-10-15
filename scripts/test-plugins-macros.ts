import assert from 'node:assert/strict'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

Object.assign(globalThis, {
  document: Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } } }),
  window: Object.assign(new EventTarget(), { location: { pathname: '/', protocol: 'http:', host: 'fluidnc.local' } }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
// The bundle is one module, so this stands in for Vite's import.meta.env.
Object.assign(import.meta, { env: { DEV: false } })

// Every request in order: "FETCH <store file>", "<action> <filename>" or "upload <path>".
let log: string[] = []
let remote: Record<string, number> = {}
let cardFiles: string[] = []

globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input), 'http://fluidnc.local')
  if (url.hostname === 'store.test') {
    const name = url.pathname.split('/').pop() ?? ''
    log.push(`FETCH ${name}`)
    const status = remote[name] ?? 404
    const body = name === 'plugin.json' ? '{"name":"P","version":"2.0.0","files":["index.html","icon.png","settings.json"]}' : 'x'
    return new Response(status === 200 ? body : 'missing', { status })
  }
  if (url.pathname.endsWith('/empty.macro')) return new Response(' \n')
  if (url.pathname.endsWith('.macro')) return new Response('', { status: 404 })
  const action = url.searchParams.get('action')
  if (!action) {
    const files = cardFiles.map(name => ({ name, size: '1' }))
    return new Response(JSON.stringify({ files, path: '/', total: '1 MB', used: '0 B', occupation: '0', status: 'Ok' }))
  }
  log.push(`${action} ${url.searchParams.get('filename')}`)
  return new Response('{"status":"Ok"}')
}) as typeof fetch

class FakeXhr {
  upload: Record<string, (() => void) | null> = {}
  status = 200
  responseText = '{"status":"Ok"}'
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open() {}
  abort() {}
  send(fd: FormData) {
    log.push(`upload ${(fd.get('myfile[]') as File).name}`)
    queueMicrotask(() => this.onload?.())
  }
}
Object.assign(globalThis, { XMLHttpRequest: FakeXhr })

const { installStorePlugin } = await import('../src/lib/plugins')

// A failed download writes nothing to the card.
const entry = { id: 'p', name: 'P', version: '2.0.0', base: 'https://store.test/p/' } as Parameters<typeof installStorePlugin>[0]
remote = { 'plugin.json': 200, 'index.html': 200, 'settings.json': 200 }
log = []
await assert.rejects(installStorePlugin(entry, 'sd', () => {}), /icon\.png/)
assert.equal(log.some(line => !line.startsWith('FETCH')), false, log.join('\n'))

// plugin.json is written last, so a cut-off install does not look complete.
remote = { 'plugin.json': 200, 'index.html': 200, 'icon.png': 200, 'settings.json': 200 }
log = []
await installStorePlugin(entry, 'sd', () => {})
assert.deepEqual(log.filter(line => line.startsWith('upload')), [
  'upload /plugins/p/index.html',
  'upload /plugins/p/icon.png',
  'upload /plugins/p/settings.json',
  'upload /plugins/p/plugin.json',
])

// An update keeps the settings the user saved in the plugin.
cardFiles = ['plugin.json', 'index.html', 'settings.json', 'old.js']
log = []
await installStorePlugin(entry, 'sd', () => {}, { cleanExisting: true })
assert.deepEqual(log.filter(line => !line.startsWith('FETCH') && !line.startsWith('createdir')), [
  'upload /plugins/p/index.html',
  'upload /plugins/p/icon.png',
  'upload /plugins/p/plugin.json',
  'delete old.js',
])
cardFiles = []

// A macro that cannot run says why in the terminal instead of doing nothing.
const { runMacro } = await import('../src/lib/macros')
const { useTerminalStore } = await import('../src/store/terminal')
const lastLine = () => useTerminalStore.getState().lines.at(-1)?.text ?? ''
await runMacro({ id: '1', label: 'Air', command: '', color: 'default', filename: '/air.macro', target: 'SD' })
assert.match(lastLine(), /Macro "Air" not run: \/air\.macro could not be read \(HTTP 404\)/)
await runMacro({ id: '2', label: 'Blank', command: '', color: 'default', filename: '/empty.macro', target: 'ESP' })
assert.match(lastLine(), /Macro "Blank" not run: \/empty\.macro is empty/)
await runMacro({ id: '3', label: '', command: '', color: 'default', filename: '/air.macro' })
assert.match(lastLine(), /Macro "Unnamed" not run: no storage is set for \/air\.macro/)

console.log('Plugin install and macro tests passed.')
