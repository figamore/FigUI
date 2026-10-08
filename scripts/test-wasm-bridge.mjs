import assert from 'node:assert/strict'
import { build } from 'esbuild'

const listeners = []
const sent = []
const parent = { postMessage: (message) => sent.push(structuredClone(message)) }
class FakeXHR {
  status = 0
  readyState = 0
  open() { this.readyState = 1 }
}
globalThis.window = {
  parent,
  addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener) },
  fetch: async () => { throw new Error('Unexpected network request') },
  XMLHttpRequest: FakeXHR,
  location: { href: 'http://demo.sim/' },
}
globalThis.ProgressEvent = class extends Event {
  constructor(type, options = {}) { super(type); Object.assign(this, options) }
}
globalThis.CloseEvent = class extends Event {
  constructor(type, options = {}) { super(type); Object.assign(this, options) }
}

const bundle = await build({
  stdin: {
    contents: `
      export * from './src/lib/parser'
      export * from './src/wasmBridge/shimTransport'
      export * from './src/wasmBridge/httpBridge'
      export * from './src/wasmBridge/WasmBridgeWebSocket'
      export { installFetchInterceptor as installDemoFetch } from './src/demo/httpSimulator'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const bridge = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const timers = new Map()
let nextTimer = 1
globalThis.setTimeout = (callback, delay) => {
  const id = nextTimer++
  timers.set(id, { callback, delay })
  return id
}
globalThis.clearTimeout = (id) => timers.delete(id)
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function respond(request, ok, value) {
  const data = request.type === 'fluidnc-fs-request'
    ? { type: 'fluidnc-fs-response', id: request.id, ok, result: value }
    : { type: 'fluidnc-shim-command-response', id: request.id, ok, response: value, ackLine: value }
  listeners.forEach(listener => listener({ source: parent, data }))
}
function expireTimers() {
  for (const [id, timer] of timers) {
    assert.ok(timer.delay > 0 && timer.delay <= 60_000)
    timers.delete(id)
    timer.callback()
  }
}

try {
  const legacy = 'FW version:FluidNC v3 # hostname:router # authentication:yes # webcommunication:Sync:8081:localhost # axis:4'
  const info = bridge.parseESP800(legacy)
  assert.equal(info.WebSocketPort, '8081')
  assert.equal(info.WebSocketIP, 'localhost')
  assert.equal(info.HostName, 'router')
  assert.equal(info.Authentication, 'Enabled')
  assert.equal(info.Axisletters, 'XYZA')
  assert.equal(bridge.parseESP800('webcommunication:Async:80:router').WebCommunication, 'Asynchronous')
  assert.deepEqual(bridge.parseESP800(JSON.stringify({ data: { ...info, WebSocketPort: 8081 } })), info)
  for (const invalid of ['ok', 'null', '{', '{"data":42}', '{"data":[]}']) {
    assert.deepEqual(bridge.parseESP800(invalid), {})
  }
  bridge.installDemoFetch()
  for (const command of ['[ESP800]', '[ESP800]json=yes']) {
    const response = await window.fetch(`/command?${new URLSearchParams({ plain: command })}`)
    const parsed = bridge.parseESP800(await response.text())
    assert.equal(parsed.WebSocketPort, '8081')
    assert.equal(parsed.WebSocketIP, 'demo.sim')
  }
  console.log('PASS ESP800 JSON, legacy fallback, and demo requests')

  for (const send of [() => bridge.sendShimCommand('$I'), () => bridge.fsRequest('list', { root: 'native_sd', path: '/' })]) {
    const success = send()
    respond(sent.at(-1), true, 'result')
    assert.equal(await success, 'result')
    assert.equal(timers.size, 0)

    const failure = send()
    respond(sent.at(-1), false, 'rejected')
    await assert.rejects(failure, /rejected/)
    assert.equal(timers.size, 0)

    const timeout = send()
    const stale = sent.at(-1)
    const rejection = assert.rejects(timeout, /timed out/)
    expireTimers()
    await rejection
    respond(stale, true, 'late response')
    assert.equal(timers.size, 0)

    const fresh = send()
    respond(stale, true, 'stale response')
    assert.equal(timers.size, 1)
    respond(sent.at(-1), true, 'fresh response')
    assert.equal(await fresh, 'fresh response')

    const originalPost = parent.postMessage
    parent.postMessage = () => { throw new Error('post failed') }
    await assert.rejects(send(), /post failed/)
    parent.postMessage = originalPost
    assert.equal(timers.size, 0)
  }
  console.log('PASS command and filesystem success, failure, timeout, late reply, and send failure')

  bridge.installXhrInterceptor()
  for (const endpoint of ['/upload', '/files']) {
    for (const ok of [true, false]) {
      const xhr = new window.XMLHttpRequest()
      let eventState
      xhr.onload = xhr.onerror = (event) => { eventState = [event.type, xhr.status, xhr.readyState] }
      xhr.open('POST', `${bridge.WASM_BRIDGE_BASE}${endpoint}`)
      assert.equal(xhr.status, 0)
      assert.equal(xhr.readyState, 1)
      const body = new FormData()
      body.append('myfile[]', new File(['G0 X1'], 'test.nc'))
      body.append('myfile[]', new File(['G0 X2'], 'second.nc'))
      const first = sent.length
      xhr.send(body)
      await tick()
      const writes = sent.slice(first)
      assert.equal(writes.length, 2)
      assert.equal(writes[0].root, endpoint === '/upload' ? 'native_sd' : 'native_localfs')
      assert.equal(xhr.status, 0)
      assert.equal(xhr.readyState, 1)
      respond(writes[0], true, '')
      await tick()
      assert.equal(eventState, undefined)
      assert.equal(xhr.status, 0)
      respond(writes[1], ok, 'write failed')
      await tick()
      assert.deepEqual(eventState, [ok ? 'load' : 'error', ok ? 200 : 0, 4])
      xhr.open('POST', endpoint)
      assert.equal(xhr.status, 0)
      assert.equal(xhr.readyState, 1)
    }
  }
  console.log('PASS upload XHR state before, during, and after writes to both filesystems')

  for (const closeEarly of [true, false]) {
    const socket = new bridge.WasmBridgeWebSocket('ws://demo')
    let opens = 0
    let lines = 0
    socket.onopen = () => opens++
    socket.onmessage = () => lines++
    if (closeEarly) socket.close()
    for (const [id, timer] of timers) { timers.delete(id); timer.callback() }
    listeners.forEach(listener => listener({ source: parent, data: { type: 'fluidnc-shim-line', line: 'ok' } }))
    assert.equal(opens, closeEarly ? 0 : 1)
    assert.equal(lines, closeEarly ? 0 : 1)
    assert.equal(socket.readyState, closeEarly ? socket.CLOSED : socket.OPEN)
    socket.close()
    listeners.forEach(listener => listener({ source: parent, data: { type: 'fluidnc-shim-line', line: 'ok' } }))
    assert.equal(lines, closeEarly ? 0 : 1)
  }
  assert.equal(timers.size, 0)
  console.log('PASS socket close before deferred open and normal listener cleanup')
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
