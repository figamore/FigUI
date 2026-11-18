import assert from 'node:assert/strict'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message)
    await delay(10)
  }
}

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

class TestDocument extends EventTarget {
  visibilityState = 'visible'
  documentElement = { classList: { add() {}, remove() {} } }
}

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set()
    peers.add(this)
    FakeBroadcastChannel.channels.set(name, peers)
  }

  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data })
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

const testDocument = new TestDocument()
Object.assign(globalThis, {
  document: testDocument,
  window: Object.assign(new EventTarget(), { BroadcastChannel: FakeBroadcastChannel, location: { pathname: '/', host: 'fluidnc.test' } }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instance: FakeWebSocket | null = null

  readyState = FakeWebSocket.CONNECTING
  bufferedAmount = 0
  binaryType = ''
  sent: Array<string | Uint8Array> = []
  machineState = 'Idle'
  reportInterval = 750
  supportsReportInterval = true
  url = ''
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null

  constructor(url: string, _protocol: string) {
    this.url = url
    FakeWebSocket.instance = this
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
      this.receive('CURRENT_ID:42')
    })
  }

  send(data: string | Uint8Array) {
    assert.equal(this.readyState, FakeWebSocket.OPEN)
    const copy = typeof data === 'string' ? data : new Uint8Array(data)
    this.sent.push(copy)
    if (copy instanceof Uint8Array && copy.length === 1 && copy[0] === 0x3f) {
      queueMicrotask(() => this.receive(`<${this.machineState}|WPos:0,0,0|MPos:0,0,0|FS:0,0>\n`))
      return
    }
    const text = typeof copy === 'string' ? copy : new TextDecoder().decode(copy)
    if (text.trim() === '$G') {
      queueMicrotask(() => this.receive('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\nok\n'))
    } else if (text.trim() === '$RI') {
      queueMicrotask(() => this.receive(this.supportsReportInterval
        ? `[MSG:INFO: websocket auto report interval is ${this.reportInterval} ms]\nok\n`
        : 'error:3\n'))
    } else if (/^\$RI=\d+$/.test(text.trim())) {
      this.reportInterval = Number(text.trim().slice(4))
      queueMicrotask(() => this.receive('ok\n'))
    } else if (text.startsWith('PING:')) {
      queueMicrotask(() => this.receive('PING:60000:60000'))
    }
  }

  receive(data: string) {
    this.onmessage?.({ data })
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }
}

Object.assign(globalThis, { WebSocket: FakeWebSocket })


const ws = await import('../src/lib/ws')
const { createPluginJogSender } = await import('../src/lib/pluginJog')
const { pluginSession, createPluginSessionStore } = await import('../src/lib/pluginSession')
const { useMachineStore } = await import('../src/store')
const { useGCodeSenderStore } = await import('../src/store/gcodeSender')
// This regression must exercise WebSocket without ever requesting HTTP.
let httpRequests = 0
Object.assign(globalThis, { fetch: async () => { httpRequests++; throw new Error('HTTP unavailable during motion') } })
await ws.connect('fluidnc.test')
const socket = FakeWebSocket.instance!
socket.receive('<Idle|MPos:0,0,0|FS:0,0>\n')
const sender = createPluginJogSender()
const jogs = () => socket.sent.filter((item): item is string => typeof item === 'string' && item.startsWith('$J='))
try {
  const first = sender.send('$J=G53 G90 G21 X10 F100')
  await waitFor(() => jogs().length === 1, 'First jog did not reach WebSocket')
  await assert.rejects(sender.send('$J=G53 G90 G21 X20 F100'), /previous jog acknowledgement/)
  assert.equal(ws.sendRaw('G0 X99'), false)
  assert.equal(useGCodeSenderStore.getState().start('G1 X99 F100', 'program.nc'), false)
  let acknowledged = false
  void first.then(() => { acknowledged = true })
  socket.machineState = 'Jog'
  socket.receive('<Jog|MPos:1,0,0|FS:100,0>\n')
  await delay(300)
  assert.equal(acknowledged, false, 'Status reports must not acknowledge a jog')
  assert.equal(useMachineStore.getState().status.state, 'Jog')
  socket.receive('ok\n')
  await first

  const startedAt = Date.now()
  const second = sender.send('$J=G53 G90 G21 X20 F100')
  await waitFor(() => jogs().length === 2, 'Continuous jog did not reach WebSocket')
  assert.ok(Date.now() - startedAt < 150, 'Continuous jogs should reuse the acknowledgement channel')
  socket.receive('error:22\n')
  await assert.rejects(second, /error:22/)
  await sender.close()
  assert.equal(ws.isResponseTrafficSuspended(), false)

  socket.machineState = 'Idle'
  socket.receive('<Idle|MPos:1,0,0|FS:0,0>\n')
  // The restarted $G query requires draining before a new jog can be sent.
  const waiting = sender.send('$J=G53 G90 G21 X30 F100')
  sender.cancel()
  await assert.rejects(waiting, /cancelled/)
  await sender.close()
  assert.equal(jogs().length, 2, 'Cancel must discard a destination waiting to be sent')

  await assert.rejects(sender.send('$J=G90 X10 F100\nG0 X99'), /one \$J=/)
  await assert.rejects(sender.send('$J=G90 X10 F100\n'), /one \$J=/)

  const final = sender.send('$J=G53 G90 G21 X40 F100')
  await waitFor(() => jogs().length === 3, 'Final jog did not reach WebSocket')
  const closing = sender.close()
  assert.equal(ws.isResponseTrafficSuspended(), true, 'Keep ownership until outstanding jog acknowledgement arrives')
  socket.receive('ok\n')
  await final
  await closing
  assert.equal(ws.isResponseTrafficSuspended(), false)
  assert.ok(socket.sent.some(item => item instanceof Uint8Array && item[0] === 0x85))
  assert.equal(httpRequests, 0, 'Live control must never use HTTP')
  const isolated = createPluginSessionStore()
  isolated.write('robot', 0, { reference: true })
  assert.equal(isolated.read('other-plugin').data, null)
  isolated.invalidate()
  assert.throws(() => isolated.write('robot', 0, { reference: true }), /session changed/)
  assert.equal(isolated.read('robot').data, null, 'A late response must not restore an invalidated reference')

  for (const invalidate of [
    () => socket.receive('<Home|MPos:0,0,0|FS:0,0>\n'),
    () => socket.receive('ALARM:1\n'),
    () => socket.receive('Grbl 3.9 [FluidNC v3.9.0]\n'),
    () => useMachineStore.getState().setControllerResetPending(true),
    () => useMachineStore.getState().setConnected(false),
  ]) {
    const stamp = pluginSession.read('robot').generation
    pluginSession.write('robot', stamp, { reference: true })
    socket.receive('<Idle|MPos:0,0,0|FS:0,0>\n')
    assert.deepEqual(pluginSession.read('robot').data, { reference: true }, 'Routine status preserves calibration')
    invalidate()
    assert.equal(pluginSession.read('robot').data, null)
    assert.ok(pluginSession.read('robot').generation > stamp)
  }
  console.log('Robot live-control WebSocket regression passed')
  console.log('Plugin connection reference lifecycle regression passed')
} finally {
  sender.dispose()
  ws.disconnect()
}
