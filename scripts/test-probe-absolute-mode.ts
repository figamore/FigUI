import assert from 'node:assert/strict'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
  }

  receive(data: string) { this.onmessage?.({ data }) }
  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }
}
Object.assign(globalThis, { WebSocket: FakeWebSocket })

const ws = await import('../src/lib/ws')
const probeMode = await import('../src/lib/probeAbsoluteMode')

await ws.connect('fluidnc.test')
const socket = FakeWebSocket.instance!
const report = (state: string) => socket.receive(`<${state}|MPos:0,0,0|FS:0,0>`)
const g90Count = () => socket.sent.filter(item => item === 'G90').length

report('Idle')
await delay(150)

// A probe that misses alarms; G90 is rejected during the alarm, so it waits
// for $X, and still goes out after the panel is gone.
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
report('Run')
await delay(50)
socket.receive('ALARM:5')
probeMode.setProbeCycleActive(false)
report('Alarm')
await delay(250)
assert.equal(g90Count(), 0, 'no G90 while the controller is in alarm')
report('Idle')
await delay(250)
assert.equal(g90Count(), 1, 'G90 is sent once the alarm is cleared')
report('Idle')
await delay(250)
assert.equal(g90Count(), 1, 'G90 is sent only once')

// A rejected probe command ends the cycle while Idle: G90 goes out at once.
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
probeMode.setProbeCycleActive(false)
await delay(100)
assert.equal(g90Count(), 2, 'G90 follows an error while Idle')

// Nothing is sent while the cycle is still running.
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
report('Run')
report('Idle')
await delay(250)
assert.equal(g90Count(), 2, 'no G90 while the probe cycle is running')
probeMode.clearProbeRelative()
probeMode.setProbeCycleActive(false)
report('Idle')
await delay(250)
assert.equal(g90Count(), 2, 'a cycle that already restored G90 sends nothing more')

// A soft reset already restores G90, so nothing is sent later.
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
report('Hold:0')
await delay(50)
ws.sendRealtime(0x18)
probeMode.setProbeCycleActive(false)
await delay(1300)
report('Idle')
await delay(250)
report('Idle')
await delay(250)
assert.equal(g90Count(), 2, 'no G90 after a soft reset')

// G90 is followed by its own $G, and only that reply ends the watch: a lost
// G90 goes out again, a G91 typed later is left alone. Replies come in the
// order the $G queries went out (the status poll sends some too).
const gc = (distance: string) => {
  socket.receive(`[GC:G0 G54 G17 G21 ${distance} G94 M5 M9 T0 F0 S0]`)
  socket.receive('ok')
}
let answered = 0
const answerAfterLastG90 = (distance: string) => {
  const g90At = socket.sent.lastIndexOf('G90')
  const earlier = socket.sent.slice(0, g90At).filter(item => item === '$G').length
  for (; answered < earlier; answered++) gc('G91')
  assert.equal(socket.sent.indexOf('$G', g90At), g90At + 1, '$G goes out right after G90')
  gc(distance)
  answered++
}
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
report('Idle')
probeMode.restoreProbeAbsolute()
await delay(50)
assert.equal(g90Count(), 3, 'the end of a cycle sends G90')
probeMode.setProbeCycleActive(false)
report('Idle')
await delay(250)
assert.equal(g90Count(), 3, 'no second G90 before its $G is answered')
answerAfterLastG90('G91')
await delay(50)
assert.equal(g90Count(), 4, 'sent again when its $G still shows G91')
answerAfterLastG90('G90')
await delay(50)
socket.receive('[GC:G0 G54 G17 G21 G91 G94 M5 M9 T0 F0 S0]') // a G91 typed later
report('Idle')
await delay(250)
assert.equal(g90Count(), 4, 'its $G showing G90 ends the watch; a later G91 is left alone')

// A drop while G90 was on its way: it is sent again after reconnecting.
probeMode.setProbeCycleActive(true)
probeMode.markProbeRelative()
probeMode.restoreProbeAbsolute()
probeMode.setProbeCycleActive(false)
await delay(50)
assert.equal(g90Count(), 5)
socket.close()
await delay(50)
await ws.connect('fluidnc.test')
const reconnected = FakeWebSocket.instance!
await delay(50)
reconnected.receive('<Idle|MPos:0,0,0|FS:0,0>')
await delay(250)
assert.equal(reconnected.sent.filter(item => item === 'G90').length, 1, 'G90 is sent again after a drop')

ws.disconnect()
console.log('probe absolute mode tests passed')
process.exit(0)
