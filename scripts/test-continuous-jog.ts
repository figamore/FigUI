import assert from 'node:assert/strict'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

Object.assign(globalThis, {
  document: Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } } }),
  window: new EventTarget(),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  fetch: async () => new Response(''),
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
  sent: Array<string | number> = []
  /** A muted controller stops answering, like a stalled WiFi link. */
  muted = false
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(_url: string, _protocol: string) {
    FakeWebSocket.instance = this
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string | Uint8Array) {
    this.sent.push(typeof data === 'string' ? data.trim() : data[0])
    if (typeof data === 'string' && !this.muted) setTimeout(() => this.onmessage?.({ data: 'ok\n' }), 5)
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1006, reason: '', wasClean: false })
  }

  close() { this.drop() }
}
Object.assign(globalThis, { WebSocket: FakeWebSocket })

const { parseControllerSettingLine } = await import('../src/lib/parser')
assert.deepEqual(parseControllerSettingLine('$32=1'), { laserMode: true })
assert.deepEqual(parseControllerSettingLine('$32=0'), { laserMode: false })
assert.deepEqual(parseControllerSettingLine('$Grbl/LaserMode=1'), { laserMode: true })
assert.equal(parseControllerSettingLine('$320=1'), null)
assert.deepEqual(parseControllerSettingLine('$30=1000'), { spindleMax: 1000 })

const ws = await import('../src/lib/ws')
const { startContinuousJog, stopContinuousJogs, CONTINUOUS_LEAD_MS, CONTINUOUS_SILENCE_MS } = await import('../src/lib/continuousJog')

const jogs = (socket: FakeWebSocket) => socket.sent.filter((item): item is string => typeof item === 'string' && item.startsWith('$J='))
const words = (line: string) => Object.fromEntries([...line.matchAll(/([XYZ])(-?\d+\.\d+)/g)].map(m => [m[1], Number(m[2])]))

// Not connected: nothing is queued to run after a reconnect.
const noop = startContinuousJog(['X+'], 600)
noop()

await ws.connect('fluidnc.test')
let socket = FakeWebSocket.instance!
await delay(50)
socket.sent.length = 0

// One axis at 600 mm/min = 0.01 mm/ms: a 300 ms lead, then segments that cover the elapsed time.
const started = Date.now()
const stop = startContinuousJog(['X+'], 600)
await delay(30)
assert.equal(jogs(socket)[0], '$J=G91 G21 F600 X3.000', 'the first segment carries the lead')
await delay(500)
stop()
const elapsed = Date.now() - started
await delay(60)
const sentWhileHeld = jogs(socket)
assert.ok(sentWhileHeld.length >= 4 && sentWhileHeld.length <= 8, `segments while held: ${sentWhileHeld.length}`)
const total = sentWhileHeld.reduce((sum, line) => sum + words(line).X, 0)
const queuedAhead = total - elapsed * 0.01
assert.ok(queuedAhead > 0 && queuedAhead <= CONTINUOUS_LEAD_MS * 0.01 + 0.5,
  `motion queued ahead of the machine stays at the lead (${queuedAhead.toFixed(3)} mm)`)
await delay(300)
assert.equal(jogs(socket).length, sentWhileHeld.length, 'no segment after stop')

// Two axes share the vector feed; signs follow the directions.
socket.sent.length = 0
const stopXY = startContinuousJog(['X+', 'Y-'], 600)
await delay(30)
stopXY()
const xy = words(jogs(socket)[0])
assert.equal(xy.X, 2.121)
assert.equal(xy.Y, -2.121)

// A dropped link ends the stream; nothing is sent after the reconnect.
socket.sent.length = 0
const stopDropped = startContinuousJog(['Z-'], 300)
await delay(30)
socket.drop()
await delay(250)
await ws.connect('fluidnc.test')
socket = FakeWebSocket.instance!
await delay(250)
stopDropped()
assert.equal(jogs(socket).length, 0, 'segments must not resume after a reconnect')

// The jog stop button ends a stream whose control is still held.
socket.sent.length = 0
const stopHeld = startContinuousJog(['Y+'], 600)
await delay(30)
stopContinuousJogs()
const afterStopButton = jogs(socket).length
await delay(300)
assert.equal(jogs(socket).length, afterStopButton, 'no segment after the stop button')
stopHeld()

// One stream at a time: a second held control takes over from the first.
socket.sent.length = 0
const stopFirst = startContinuousJog(['X+'], 600)
await delay(30)
const stopSecond = startContinuousJog(['Y+'], 600)
await delay(300)
assert.equal(jogs(socket).filter(line => 'X' in words(line)).length, 1, 'the first stream stops when the second starts')
assert.ok(jogs(socket).filter(line => 'Y' in words(line)).length >= 2, 'the second stream runs')
stopFirst()
stopSecond()

// The jog watchdog cancels a jog without held input; the stream must not restart it.
const { startWatchdog, stopWatchdog } = await import('../src/lib/jogWatchdog')
const { useMachineStore } = await import('../src/store')
socket.sent.length = 0
startWatchdog()
useMachineStore.getState().updateStatus({ state: 'Jog' })
const stopUnheld = startContinuousJog(['X+'], 600)
await delay(400)
const afterWatchdog = jogs(socket).length
assert.ok(afterWatchdog <= 2, `segments after the watchdog stepped in: ${afterWatchdog}`)
await delay(300)
assert.equal(jogs(socket).length, afterWatchdog, 'no segment once the watchdog cancels')
stopUnheld()
stopWatchdog()
useMachineStore.getState().updateStatus({ state: 'Idle' })

// A controller that stops answering ends the stream, though the socket stays open.
socket.sent.length = 0
const stopStalled = startContinuousJog(['X-'], 600)
await delay(30)
socket.muted = true
await delay(CONTINUOUS_SILENCE_MS + 300)
const sentWhileStalled = jogs(socket).length
assert.ok(sentWhileStalled <= CONTINUOUS_SILENCE_MS / 100 + 2, `segments into a stalled link: ${sentWhileStalled}`)
await delay(300)
assert.equal(jogs(socket).length, sentWhileStalled, 'no segment once the link has stalled')
stopStalled()

ws.disconnect()
console.log('continuous jog tests passed')
