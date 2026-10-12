import assert from 'node:assert/strict'

const pathname = process.argv[2] ?? '/ui/figui/'
const storage = { getItem: () => null, setItem() {} }
Object.assign(globalThis, {
  localStorage: storage,
  sessionStorage: storage,
  window: Object.assign(new EventTarget(), { location: { pathname } }),
  document: { documentElement: { classList: { add() {}, remove() {} } } },
})

const { loadMacroCfg, setBase, uiDir } = await import('../src/lib/http')
setBase('http://fluidnc.local')
const originalFetch = globalThis.fetch
const originalWarn = console.warn
const requests: string[] = []
const warnings: unknown[][] = []
const shared = '/macrocfg.json'
const own = `${uiDir}macrocfg.json`
const macro = (name: string) => JSON.stringify([{ index: 0, name, filename: `${name}.nc` }])

function respond(reply: () => Response | Promise<Response>) {
  requests.length = 0
  warnings.length = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'http://fluidnc.local')
    requests.push(url.pathname)
    if (uiDir && url.pathname === own) {
      assert.equal(init?.cache, 'no-store')
      return reply()
    }
    assert.equal(url.pathname, shared)
    return uiDir ? new Response(macro('shared')) : reply()
  }
}

try {
  console.warn = (...args) => { warnings.push(args) }
  respond(() => new Response(macro('own')))
  assert.equal((await loadMacroCfg())[0].label, 'own')
  assert.deepEqual(requests, [uiDir ? own : shared])
  assert.deepEqual(warnings, [])

  for (const body of ['[]', 'invalid JSON']) {
    respond(() => new Response(body))
    assert.deepEqual(await loadMacroCfg(), [])
    assert.deepEqual(requests, [uiDir ? own : shared], 'empty or malformed files must not load shared macros')
    assert.equal(warnings.length, body === '[]' ? 0 : 1)
  }

  respond(() => new Response('Not found', { status: 404 }))
  assert.deepEqual((await loadMacroCfg()).map(entry => entry.label), uiDir ? ['shared'] : [])
  assert.deepEqual(requests, uiDir ? [own, shared] : [shared])
  assert.equal(warnings.length, uiDir ? 0 : 1)

  for (const status of [401, 403, 500, 503]) {
    respond(() => new Response('Service unavailable', { status }))
    assert.deepEqual(await loadMacroCfg(), [])
    assert.deepEqual(requests, [uiDir ? own : shared], `HTTP ${status} must not trigger fallback`)
    assert.equal(warnings.length, 1)
    assert.equal((warnings[0][1] as Error).message, `HTTP ${status}`)
    if (uiDir) assert.equal((warnings[0][1] as Error & { status: number }).status, status)
  }

  for (const error of [new TypeError('Failed to fetch'), new Error('HTTP 404')]) {
    respond(() => { throw error })
    assert.deepEqual(await loadMacroCfg(), [])
    assert.deepEqual(requests, [uiDir ? own : shared], 'network errors must not trigger fallback')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0][1], error)
  }

  const readError = new Error('Body read failed')
  respond(() => {
    const response = new Response()
    response.text = async () => { throw readError }
    return response
  })
  assert.deepEqual(await loadMacroCfg(), [])
  assert.deepEqual(requests, [uiDir ? own : shared], 'body read errors must not trigger fallback')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1], readError)
  console.log(`Macro configuration fallback and failure reporting checks passed (${pathname})`)
} finally {
  globalThis.fetch = originalFetch
  console.warn = originalWarn
}
