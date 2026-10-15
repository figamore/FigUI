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
  window: new EventTarget(),
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
    // FluidNC answers every $G, including the page's periodic poll.
    if (data === '$G\n') queueMicrotask(() => {
      this.receive('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]')
      this.receive('ok')
    })
  }

  receive(data: string) { this.onmessage?.({ data }) }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1006, reason: '', wasClean: false })
  }

  close() { this.drop() }
}
Object.assign(globalThis, { WebSocket: FakeWebSocket })

const ws = await import('../src/lib/ws')
const { runMacro } = await import('../src/lib/macros')
const { useTerminalStore } = await import('../src/store/terminal')
const { useGCodeStore } = await import('../src/store/gcode')

const RUN_REPORT = '<Run|MPos:1,2,0|FS:600,0|SD:12.50,/sd/job.nc>'
const IDLE_REPORT = '<Idle|MPos:1,2,0|FS:0,0>'

await ws.connect('fluidnc.test')
let socket = FakeWebSocket.instance!
await delay(50)
// The modal state query sent on connect is answered by the fake socket.
assert.equal(ws.isResponseTrafficQuiescent(0), true)

const wire = () => socket.sent.length
const sentSince = (mark: number) => socket.sent.slice(mark)
const gcQueries = () => socket.sent.filter(item => item === '$G').length

// ── A job started here holds every line until its late reply ─────────────────
assert.equal(ws.sendRaw('G0 M5'), true)
assert.equal(ws.sendRaw('$SD/Run=/job.nc'), true)
useGCodeStore.getState().startTrackedJob('controller')
assert.equal(ws.isLineInputHeldByJob(), true, 'a queued $SD/Run already holds the input')
assert.equal(ws.sendRaw('G0 X5'), false, 'a line queued behind $SD/Run is refused')
await delay(50)
assert.deepEqual(socket.sent.slice(-2), ['G0 M5', '$SD/Run=/job.nc'])
socket.receive('ok') // the reply to G0 M5, not to $SD/Run
assert.equal(ws.isLineInputHeldByJob(), true, 'an earlier line\'s ok does not end the job')
socket.receive(RUN_REPORT)

let mark = wire()
assert.equal(ws.sendRaw('G0 X10'), false, 'a terminal line is refused')
assert.equal(ws.sendRealtime(0x21), true, 'feed hold still goes out')
assert.equal(ws.sendRealtime(0x3F), true, 'a status request still goes out')
assert.equal(ws.sendSilentAlarmQuery(), true, 'a one-off query waits for the job')
assert.equal(ws.isResponseTrafficQuiescent(0), false, 'no local stream may take the line during the job')
await delay(50)
// (a periodic '?' status poll may add another 0x3F)
assert.deepEqual(sentSince(mark).slice(0, 2), [0x21, 0x3F], 'the realtime bytes are on the wire')
assert.ok(!sentSince(mark).some(item => typeof item === 'string'), 'and no line')

// The $G poll (every 2 s without auto-reports) stands aside.
const gcBefore = gcQueries()
await delay(2200)
assert.equal(gcQueries(), gcBefore, 'no $G is polled during the job')
assert.ok(!sentSince(mark).some(item => typeof item === 'string'), 'no line of any kind went out')

// A macro is refused with a terminal note.
const terminalLines = () => useTerminalStore.getState().lines.map(line => line.text)
await runMacro({ label: 'Park', command: 'G0 X0 Y0' } as Parameters<typeof runMacro>[0])
assert.match(terminalLines().at(-1)!, /Macro "Park" not sent: FluidNC would run it only after the SD job ends/)
assert.ok(!socket.sent.includes('G0 X0 Y0'))

// A feed hold keeps the job's hold on the input, and Resume is a realtime byte.
const { useMachineStore } = await import('../src/store')
socket.receive('<Hold:0|MPos:1,2,0|FS:0,0|SD:60.00,/sd/job.nc>')
assert.equal(ws.isLineInputHeldByJob(), true, 'a feed hold does not end the job')
assert.equal(useMachineStore.getState().status.sdFilename, '/sd/job.nc')
mark = wire()
assert.equal(ws.sendRealtime(0x7E), true, 'Resume still goes out')
assert.equal(ws.sendRaw('G0 X10'), false)
await delay(50)
assert.ok(sentSince(mark).includes(0x7E))
assert.ok(!sentSince(mark).some(item => typeof item === 'string'))
socket.receive('<Run|MPos:1,2,0|FS:600,0|SD:60.10,/sd/job.nc>')
assert.equal(ws.isLineInputHeldByJob(), true)

// FluidNC answers $SD/Run when the file ends; that ok ends the hold.
socket.receive(RUN_REPORT)
socket.receive('ok')
assert.equal(ws.isLineInputHeldByJob(), false, 'the late ok of $SD/Run ends the hold')
await delay(50)
assert.ok(socket.sent.at(-1) === '$A', 'the waiting alarm query goes out once the job ends')
socket.receive('Active alarm: 1 (Hard limit)')
socket.receive('ok')
assert.equal(ws.isResponseTrafficQuiescent(0), true, 'the $A gets its own reply, not the late ok')
socket.receive(IDLE_REPORT)
mark = wire()
assert.equal(ws.sendRaw('G0 X10'), true, 'lines are sent again after the job')
await delay(50)
// A periodic '?' status poll may fall in this window; only lines matter here.
assert.deepEqual(sentSince(mark).filter(item => typeof item === 'string'), ['G0 X10'])
socket.receive('ok')
const gcAfter = gcQueries()
// The reports above read as auto-reporting; once they stop, polling returns.
await delay(4500)
assert.ok(gcQueries() > gcAfter, 'the $G poll resumes after the job')
useGCodeStore.getState().finishTrackedJob('controller')

// ── A job adopted from another device does not hold this page's lines ────────
useGCodeStore.getState().startTrackedJob('controller')
socket.receive('<Run|MPos:1,2,0|FS:600,0|SD:40.00,/sd/other.nc>')
assert.equal(ws.isLineInputHeldByJob(), false)
mark = wire()
assert.equal(ws.sendRaw('$G'), true, 'a line goes out during a job started elsewhere')
await delay(50)
// A periodic '?' status poll may fall in this window; only lines matter here.
assert.deepEqual(sentSince(mark).filter(item => typeof item === 'string'), ['$G'])
socket.receive(IDLE_REPORT)
useGCodeStore.getState().cancelTrackedJob('controller')

// ── A refused file answers at once and holds nothing ─────────────────────────
assert.equal(ws.sendRaw('$SD/Run=/missing.nc'), true)
await delay(50)
assert.equal(ws.isLineInputHeldByJob(), true)
socket.receive('error:60')
assert.equal(ws.isLineInputHeldByJob(), false, 'the immediate error ends the hold')

// ── A reset from elsewhere drops a reply; its banner resets the count ────────
const BANNER = "Grbl 4.1.1 [FluidNC v4.1.1 (wifi) '$' for help]"
assert.equal(ws.sendRaw('$H'), true) // a pendant resets during homing
await delay(50)
socket.receive(BANNER)
assert.equal(ws.sendRaw('$SD/Run=/missing.nc'), true)
await delay(50)
socket.receive('error:60')
assert.equal(ws.isLineInputHeldByJob(), false, 'the refusal is the job reply')

// The banner also ends a job held here.
assert.equal(ws.sendRaw('$SD/Run=/job.nc'), true)
await delay(50)
socket.receive(RUN_REPORT)
socket.receive(BANNER)
assert.equal(ws.isLineInputHeldByJob(), false, 'a reset elsewhere ends the hold')
socket.receive(IDLE_REPORT)

// ── A reply lost without a banner, then a refused file ───────────────────────
// The error is taken for the lost reply, and no job ever shows.
assert.equal(ws.sendRaw('$H'), true) // its reply never comes
assert.equal(ws.sendRaw('$SD/Run=/missing.nc'), true)
await delay(50)
socket.receive('error:60')
socket.receive(IDLE_REPORT)
assert.equal(ws.isLineInputHeldByJob(), true, 'a job may still be starting')
await delay(3100)
socket.receive(IDLE_REPORT)
assert.equal(ws.isLineInputHeldByJob(), false, 'reports without a job end the hold')
mark = wire()
assert.equal(ws.sendRaw('G0 X1'), true)
await delay(50)
assert.deepEqual(sentSince(mark).filter(item => typeof item === 'string'), ['G0 X1'])
socket.receive('ok')

// ── A reply lost to a reset elsewhere: the job's SD: field ending releases ───
assert.equal(ws.sendRaw('G4 P0'), true) // its reply never comes
assert.equal(ws.sendRaw('$SD/Run=/job.nc'), true)
await delay(50)
socket.receive(RUN_REPORT)
socket.receive('ok') // the job's reply, taken for the G4's
assert.equal(ws.isLineInputHeldByJob(), true)
socket.receive('<Run|MPos:1,2,0|FS:600,0>')
assert.equal(ws.isLineInputHeldByJob(), false, 'a report without SD: ends the hold')

// ── A reset from this page ends the job and the hold ─────────────────────────
assert.equal(ws.sendRaw('$SD/Run=/job.nc'), true)
await delay(50)
socket.receive(RUN_REPORT)
assert.equal(ws.sendRealtime(0x18), true)
await delay(50)
assert.equal(ws.isLineInputHeldByJob(), false, 'a reset ends the hold')
socket.receive('error:3') // FluidNC's reply for the aborted job
await delay(1100)
mark = wire()
assert.equal(ws.sendRaw('$X'), true, 'lines are sent again after the reset')
await delay(50)
assert.ok(sentSince(mark).includes('$X'))
socket.receive('ok')

// ── A dropped connection: the new one is a new FluidNC channel ───────────────
assert.equal(ws.sendRaw('$SD/Run=/job.nc'), true)
await delay(50)
assert.equal(ws.isLineInputHeldByJob(), true)
socket.drop()
assert.equal(ws.isLineInputHeldByJob(), false)
await ws.connect('fluidnc.test')
socket = FakeWebSocket.instance!
await delay(50)
socket.receive(RUN_REPORT)
mark = wire()
assert.equal(ws.sendRaw('$G'), true, 'the job does not hold the new connection')
await delay(50)
assert.ok(sentSince(mark).includes('$G'))

// ── $32 (laser mode) is read again after a spindle change ────────────────────
const { parseControllerSettingLine } = await import('../src/lib/parser')
assert.deepEqual(parseControllerSettingLine('$32=1'), { laserMode: true })
assert.deepEqual(parseControllerSettingLine('$Grbl/LaserMode=Off'), { laserMode: false })
socket.receive('[MSG:INFO: Changed to spindle:Laser]')
for (let waited = 0; !socket.sent.includes('$$') && waited < 3000; waited += 100) await delay(100)
assert.ok(socket.sent.includes('$$'), 'the settings are read again after a spindle change')
socket.receive('$30=1000')
socket.receive('$32=1')
socket.receive('ok')
assert.equal(useMachineStore.getState().controllerSettings.laserMode, true)

// ── Nothing issued while disconnected runs after a reconnect, but jog cancel ─
socket.drop()
assert.equal(ws.sendRaw('G0 X50'), false, 'a command typed while disconnected is not sent')
assert.equal(ws.sendRealtime(0x7E), false, 'cycle start while disconnected is not sent')
assert.equal(ws.sendRealtime(0x85), false, 'jog cancel is not sent yet')
ws.sendRealtime(0x85)
await ws.connect('fluidnc.test')
socket = FakeWebSocket.instance!
await delay(60)
assert.ok(!socket.sent.includes('G0 X50'), 'a command typed while disconnected must not run after reconnect')
assert.ok(!socket.sent.includes(0x7E), 'cycle start must not replay after reconnect')
assert.equal(socket.sent.filter(item => item === 0x85).length, 1, 'jog cancel is replayed once after reconnect')

// ── A disconnect while the socket is still opening settles that connect ─────
ws.disconnect()
const opening = ws.connect('fluidnc.test')
ws.disconnect()
const outcome = await Promise.race([
  opening.then(() => 'opened', () => 'rejected'),
  delay(200).then(() => 'pending'),
])
assert.equal(outcome, 'rejected', 'the pending connect is rejected at once, not after its timeout')

console.log('line gate tests passed')
