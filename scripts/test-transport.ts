import assert from 'node:assert/strict'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
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

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1006, reason: '', wasClean: false })
  }

  close() { this.drop() }
}
Object.assign(globalThis, { WebSocket: FakeWebSocket })

// The startup queries go over HTTP first.
let commandReplies: Array<() => Response> = []
Object.assign(globalThis, {
  fetch: async (input: string) => {
    const reply = commandReplies.shift()
    assert.ok(reply, `unexpected request ${input}`)
    return reply()
  },
})

const http = await import('../src/lib/http')
http.setBase('http://fluidnc.test')
const ws = await import('../src/lib/ws')
const { useMachineStore } = await import('../src/store')

let statusUpdates = 0
useMachineStore.subscribe((state, previous) => { if (state.status !== previous.status) statusUpdates++ })

await ws.connect('fluidnc.test')
let socket = FakeWebSocket.instance!

// ── Status reports: a burst is merged, state changes are applied at once ─────
await delay(150)
const updatesBefore = statusUpdates
for (let i = 1; i <= 40; i++) socket.receive(`<Idle|MPos:${i},0,0|FS:0,0|WCO:0,0,0>`)
assert.ok(statusUpdates - updatesBefore <= 2, `a burst must not apply every report (${statusUpdates - updatesBefore})`)
assert.equal(useMachineStore.getState().statusReceived, true, 'the first applied report counts as received')
socket.receive('<Run|MPos:41,0,0|FS:100,0>')
assert.equal(useMachineStore.getState().status.state, 'Run', 'a state change is applied at once')
assert.equal(useMachineStore.getState().status.mpos.x, 41)
for (let i = 42; i <= 45; i++) socket.receive(`<Run|MPos:${i},0,0|FS:100,0>`)
socket.receive('ALARM:1')
await delay(150)
assert.equal(useMachineStore.getState().status.state, 'Alarm', 'a deferred report must not overwrite a later alarm')
assert.equal(useMachineStore.getState().status.mpos.x, 45, 'the deferred report is applied before the alarm')

socket.receive('<Alarm:1|MPos:46,0,0|FS:0,0>')
socket.receive('<Alarm:1|MPos:47,0,0|FS:0,0>')
await delay(150)
assert.equal(useMachineStore.getState().status.mpos.x, 47, 'the latest deferred report is applied after the interval')

socket.receive('<Hold:1|MPos:47,0,0|FS:0,0>')
socket.receive('<Hold:0|MPos:47,0,0|FS:0,0>')
assert.equal(useMachineStore.getState().status.holdComplete, true, 'a hold completing is applied at once')
socket.receive('<Hold:0|MPos:47,0,0|FS:0,0|Pn:Q>')
assert.equal(useMachineStore.getState().status.pinState, 'Q', 'a pin change is applied at once')
socket.receive('<Idle|MPos:47,0,0|FS:0,0>')

// ── Silent queries: a reply lost to a reset does not block a local stream ────
ws.disconnect()
await ws.connect('fluidnc.test')
socket = FakeWebSocket.instance!
await delay(100)
assert.ok(socket.sent.includes('$G'), 'the modal state is queried on connect')
assert.equal(ws.isResponseTrafficQuiescent(0), false, 'the $G reply is still due')
assert.equal(ws.sendRealtime(0x18), true)
await delay(1100)
assert.equal(ws.isResponseTrafficQuiescent(0), true, 'a $G that the reset dropped must be forgotten')

const shownLines: string[] = []
const stopShowing = ws.onLine(line => shownLines.push(line))

// Stop during a job: the $G reply is lost and ALARM:3 asks for the alarm name
// inside the cooldown. The $A waits for the cooldown instead of queuing
// behind the dead $G, and nothing leaks into the terminal.
await delay(1000)
assert.ok(socket.sent.filter(item => item === '$G').length >= 2, 'the $G poll runs')
ws.suspendBackgroundTraffic() // no further $G poll
assert.equal(ws.isResponseTrafficQuiescent(0), false, 'a $G reply is due')
ws.sendRealtime(0x18)
await delay(50)
socket.receive('ALARM:3')
const alarmQueries = () => socket.sent.filter(item => item === '$A').length
let alarmQueriesAnswered = alarmQueries()
const answerAlarmQueries = () => { // the controller answers at once
  for (; alarmQueriesAnswered < alarmQueries(); alarmQueriesAnswered++) {
    socket.receive('Active alarm: 3 (Abort during cycle)')
    socket.receive('ok')
  }
}
const alarmQueriesBefore = alarmQueries()
assert.equal(ws.sendSilentAlarmQuery(), true)
await delay(100)
answerAlarmQueries()
assert.equal(alarmQueries(), alarmQueriesBefore, 'no query during the cooldown')
await delay(1000)
answerAlarmQueries()
assert.equal(alarmQueries(), alarmQueriesBefore + 1, 'the query goes out after the cooldown')
assert.equal(useMachineStore.getState().status.alarmName, 'Abort during cycle')
assert.equal(ws.isResponseTrafficQuiescent(0), true, 'the $A reply ends its own query')
assert.deepEqual(shownLines, ['ALARM:3'])
shownLines.length = 0

// ── report_inches is learned over the websocket when HTTP refuses $$ ─────────
// FluidNC refuses $Report/Inches outside Idle/Alarm (error:8) but answers $$
// in any state, starting with $13.
const busy = () => new Response('Try again when not moving', { status: 503 })
commandReplies = [busy, busy]
await ws.sendStartupQueries()
await delay(100)
assert.ok(socket.sent.includes('$$'), 'the settings are asked over the websocket during motion')
assert.ok(!socket.sent.includes('$Report/Inches'), 'not the query FluidNC refuses during motion')
socket.receive('$13=1')
socket.receive('$10=1')
socket.receive('$30=1000')
socket.receive('$100=80.000')
socket.receive('ok')
assert.equal(useMachineStore.getState().controllerSettings.reportInches, true)
assert.equal(useMachineStore.getState().controllerSettings.spindleMax, 1000)
assert.equal(ws.isResponseTrafficQuiescent(0), true)
commandReplies = [busy, busy]
await ws.sendStartupQueries()
await delay(100)
socket.receive('error:8')
assert.equal(ws.isResponseTrafficQuiescent(0), true, 'a refused settings query does not stay pending')
assert.deepEqual(shownLines, [], 'the query and its reply stay out of the terminal')
stopShowing()
useMachineStore.getState().updateControllerSettings({ reportInches: false })
ws.resumeBackgroundTraffic()
await delay(50)

// ── Polling stands aside while the controller auto-reports ───────────────────
const polls = () => socket.sent.filter(item => item === 0x3F).length
const gcQueries = () => socket.sent.filter(item => item === '$G').length
const autoReports = async (count: number) => {
  for (let i = 0; i < count; i++) {
    socket.receive(`<Jog|MPos:${i},0,0|FS:500,0>`)
    await delay(100)
  }
}
socket.receive('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]') // pushed on a modal change
const pollsBefore = polls()
const gcBefore = gcQueries()
await autoReports(25)
assert.equal(polls(), pollsBefore, 'no ? while auto-reports arrive')
assert.equal(gcQueries(), gcBefore, 'no $G while auto-reports and [GC:] pushes arrive')

const realNow = Date.now
let clockOffset = 0
Date.now = () => realNow() + clockOffset
clockOffset += 30_000 // no [GC:] for 30 s
await autoReports(25)
assert.ok(gcQueries() > gcBefore, '$G still runs when no [GC:] has come for 30 s')
await delay(1100)
assert.ok(polls() > pollsBefore, 'polling resumes once auto-reports stop')

// ── Liveness: a paused page is not judged on silence it could not measure ────
const isConnected = () => useMachineStore.getState().connected
clockOffset += 30_000 // the page was frozen for 30 s
await delay(2100)
assert.equal(isConnected(), true, 'the first check after a pause does not drop the link')
socket.receive('<Idle|MPos:0,0,0|FS:0,0>')
clockOffset += 30_000
await delay(2100)
assert.equal(isConnected(), true, 'traffic heard since the last check keeps the link')
clockOffset += 30_000
await delay(2100)
assert.equal(isConnected(), false, 'a second late check with nothing heard drops the link')
Date.now = realNow

ws.disconnect()
console.log('transport tests passed')
