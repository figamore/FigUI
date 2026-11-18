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

const { installStorePlugin, loadPluginEntry, STORE_REGISTRY_URL } = await import('../src/lib/plugins')

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

// An installed plugin can use its matching GitHub copy before reading the card.
const deviceFetch = globalThis.fetch
const githubBase = 'https://raw.githubusercontent.com/figamore/FigUI/main/plugins/utility-generator/'
const cdnBase = 'https://cdn.jsdelivr.net/gh/figamore/FigUI@main/plugins/utility-generator/'
const installed = {
  id: 'Utility Generator',
  manifest: { name: 'Utility Generator', version: '2.0.0', entry: 'plugin page.html' },
  entryUrl: 'http://fluidnc.local/sd/plugins/Utility%20Generator/plugin%20page.html',
  fs: 'sd',
} as const
let onlineManifest: Parameters<typeof loadPluginEntry>[0]['manifest'] = installed.manifest
let unavailableUrl: string | undefined
let stalledUrl: string | undefined
globalThis.fetch = async (input, init) => {
  const url = String(input)
  log.push(url)
  if (url === stalledUrl) return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })
  if (url === unavailableUrl) return new Response('', { status: 404 })
  if (url === STORE_REGISTRY_URL) return Response.json({ plugins: [{ id: installed.id, base: githubBase }] })
  if (url === githubBase + 'plugin.json' || url === cdnBase + 'plugin.json') return Response.json(onlineManifest)
  if (url === githubBase + 'plugin%20page.html' || url === cdnBase + 'plugin%20page.html') return new Response('<html>GitHub</html>')
  if (url === cdnBase + 'style.css') return new Response('body { color: red }')
  if (url === installed.entryUrl) return new Response('<html>SD</html>')
  throw new Error(`Unexpected request: ${url}`)
}
try {
  const load = (plugin = installed) => loadPluginEntry(plugin, new AbortController().signal)
  const cardCopy = { html: '<html>SD</html>', entryUrl: installed.entryUrl }
  log = []
  assert.deepEqual(await load(), { html: '<html>GitHub</html>', entryUrl: githubBase + 'plugin%20page.html' })
  assert.deepEqual(log, [STORE_REGISTRY_URL, githubBase + 'plugin.json', githubBase + 'plugin%20page.html'])

  onlineManifest = { ...installed.manifest, files: ['plugin page.html', 'style.css', 'settings.json'] }
  const withAssets = { ...installed, manifest: { ...installed.manifest, files: onlineManifest.files } }
  log = []
  assert.deepEqual(await load(withAssets), { html: '<html>GitHub</html>', entryUrl: cdnBase + 'plugin%20page.html' })
  assert.deepEqual(log, [STORE_REGISTRY_URL, cdnBase + 'plugin.json', cdnBase + 'plugin%20page.html', cdnBase + 'style.css'])

  unavailableUrl = cdnBase + 'style.css'
  assert.deepEqual(await load(withAssets), cardCopy)
  unavailableUrl = githubBase + 'plugin%20page.html'
  assert.deepEqual(await load(), cardCopy)
  unavailableUrl = undefined
  onlineManifest = { ...installed.manifest, version: '3.0.0' }
  assert.deepEqual(await load(), cardCopy)
  log = []
  assert.deepEqual(await loadPluginEntry({ ...installed, id: 'custom' }, new AbortController().signal), cardCopy)
  assert.deepEqual(log, [STORE_REGISTRY_URL, installed.entryUrl])

  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  log = []
  assert.deepEqual(await load(), cardCopy)
  assert.deepEqual(log, [installed.entryUrl])
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })

  stalledUrl = STORE_REGISTRY_URL
  log = []
  assert.deepEqual(await load(), cardCopy)
  assert.deepEqual(log, [STORE_REGISTRY_URL, installed.entryUrl])

  log = []
  const controller = new AbortController()
  const cancelled = loadPluginEntry(installed, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.deepEqual(log, [STORE_REGISTRY_URL])
} finally {
  globalThis.fetch = deviceFetch
}

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

console.log('Plugin install, launch, and macro tests passed.')
