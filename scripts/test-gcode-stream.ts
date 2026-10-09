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
  window: Object.assign(new EventTarget(), { BroadcastChannel: FakeBroadcastChannel }),
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
  singleBlock = false
  supportsBlockMode = true
  reportModeChanges = true
  modeReply = 'info'
  failModeRequest = false
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
      queueMicrotask(() => this.reportStatus())
      return
    }
    const text = typeof copy === 'string' ? copy : new TextDecoder().decode(copy)
    if (/^\$GB=(On|Off)$/.test(text.trim())) {
      // A paused controller file owns this input lane until its final ack.
      // Leave $GB queued: production mode controls must use the HTTP endpoint.
      return
    } else if (text.trim() === '$G') {
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

  reportStatus() {
    this.receive(`<${this.machineState}|WPos:0,0,0|MPos:0,0,0|FS:0,0${this.singleBlock ? '|Pn:Q' : ''}>\n`)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }
}

Object.assign(globalThis, { WebSocket: FakeWebSocket })
const modeRequests: Array<{ command: string; signal: AbortSignal }> = []
Object.assign(globalThis, {
  fetch: async (input: string, options: { signal: AbortSignal }) => {
    const url = new URL(input, 'http://fluidnc.test')
    const command = url.searchParams.get('plain') ?? ''
    assert.equal(url.pathname, '/command')
    assert.match(command, /^\$GB=(On|Off)$/)
    assert.equal(url.searchParams.get('PAGEID'), '42')
    modeRequests.push({ command, signal: options.signal })
    const controller = FakeWebSocket.instance!
    if (controller.failModeRequest) throw new Error('network failure')
    if (!controller.supportsBlockMode) return new Response('error:3\n')
    if (controller.modeReply === 'silent') return new Response('')
    controller.singleBlock = command === '$GB=On'
    if (controller.reportModeChanges) queueMicrotask(() => controller.reportStatus())
    return new Response(controller.modeReply === 'ok' ? 'ok\n'
      : `[MSG:INFO: Single Block Mode ${controller.singleBlock ? 'Enabled' : 'Disabled'}]\nok\n`)
  },
})

const ws = await import('../src/lib/ws')
const { useMachineStore } = await import('../src/store')
const { useGCodeSenderStore } = await import('../src/store/gcodeSender')
const { useGCodeStore } = await import('../src/store/gcode')
const { controllerRunCommand, controllerPathsMatch } = await import('../src/lib/controllerFiles')
const { useSingleBlockStore } = await import('../src/store/singleBlock')
const { parseStepReport, pendingBlockMatchesSource, supportsSingleBlock } = await import('../src/lib/singleBlock')
const { parseStatusReport } = await import('../src/lib/parser')

await ws.connect('fluidnc.test')
const socket = FakeWebSocket.instance!
assert.equal(
  new URL(socket.url).searchParams.get('independent_session'),
  '1',
  'websocket must opt into a per-tab FluidNC session',
)
let sessionTakeovers = 0
const stopWatchingTakeovers = ws.onSessionTaken(() => { sessionTakeovers++ })
const secondTab = new FakeBroadcastChannel('fluidui-tab-coordination-v1')
secondTab.postMessage('tab-active')
assert.equal(sessionTakeovers, 1, 'a newly active browser tab must preserve FluidNC session-takeover signaling')
stopWatchingTakeovers()
secondTab.close()
useMachineStore.getState().updateStatus({ state: 'Idle' })
await delay(300)

// Internal storage is served at bare paths, even on devices with no SD card.
assert.equal(controllerRunCommand('/multi-tool-demo-3.nc'), '$LocalFS/Run=/multi-tool-demo-3.nc')
assert.equal(controllerRunCommand('/jobs/multi-tool-demo-3.nc'), '$LocalFS/Run=/jobs/multi-tool-demo-3.nc')
assert.equal(controllerRunCommand('/localfs/test.nc'), '$LocalFS/Run=/localfs/test.nc')
assert.equal(controllerRunCommand('/sd/test.nc'), '$SD/Run=/sd/test.nc')
assert.ok(controllerPathsMatch('/localfs/jobs/test.nc', '/jobs/test.nc'))
assert.ok(!controllerPathsMatch('/sd/jobs/test.nc', '/jobs/test.nc'))
assert.ok(!controllerPathsMatch('/localfs/macros/test.nc', '/jobs/test.nc'))
assert.ok(useGCodeStore.getState().cancelAndStartJob('/multi-tool-demo-3.nc'))
await waitFor(() => socket.sent.some(item => item === '$LocalFS/Run=/multi-tool-demo-3.nc\n'), 'internal Start without preview used the wrong filesystem')
assert.ok(!socket.sent.some(item => typeof item === 'string' && item.startsWith('$SD/Run=')), 'internal jobs must not touch the SD card')
assert.ok(useGCodeStore.getState().cancelAndStartJob('/sd/test.nc'))
await waitFor(() => socket.sent.some(item => item === '$SD/Run=/sd/test.nc\n'), 'SD Start without preview used the wrong filesystem')
useGCodeStore.getState().clear()

// Exercise single-block controls through the actual transport and status parser.
assert.deepEqual(parseStepReport('[MSG:INFO: Step /sd/folder/test.nc:12 G1 X10.000 Y10.000 F...]'), {
  path: '/sd/folder/test.nc', line: 12, preview: 'G1 X10.000 Y10.000 F...',
})
assert.equal(parseStepReport('[MSG:INFO: Step /sd/test.nc:0 G0]'), null)
assert.equal(parseStepReport('[MSG:INFO: Single Block Mode Enabled]'), null)
assert.deepEqual(parseStepReport('[MSG:INFO: Step /localfs/a:b.nc:2 (brackets [ok])]'), {
  path: '/localfs/a:b.nc', line: 2, preview: '(brackets [ok])',
})
assert.ok(pendingBlockMatchesSource({ path: '/sd/folder/test.nc', line: 12, preview: '' }, '/sd/folder/test.nc'))
assert.ok(pendingBlockMatchesSource({ path: '/localfs/multi-tool-demo-3.nc', line: 12, preview: '' }, '/multi-tool-demo-3.nc'))
assert.ok(!pendingBlockMatchesSource({ path: '/sd/multi-tool-demo-3.nc', line: 12, preview: '' }, '/multi-tool-demo-3.nc'))
assert.ok(!pendingBlockMatchesSource({ path: '/sd/macros/test.nc', line: 12, preview: '' }, '/jobs/test.nc'))
assert.ok(!pendingBlockMatchesSource({ path: 'macro0', line: 1, preview: '' }, null))
assert.ok(!pendingBlockMatchesSource({ path: '/sd/test.nc', line: 1, preview: '' }, '/localfs/test.nc'))
assert.equal(parseStepReport('[MSG:INFO: Step /sd/test.nc:12 (note:3 foo)]')?.line, 12)
assert.equal(parseStatusReport('<Hold:1|Pn:Q>')?.holdComplete, false)
assert.equal(parseStatusReport('<Hold:0|Pn:Q>')?.holdComplete, true)

const block = () => useSingleBlockStore.getState()
for (const version of [undefined, '', 'FluidNC v3.9.9', '4.0.9', '4.1.0']) {
  assert.equal(supportsSingleBlock(version), false, `${version} must not support single block`)
}
for (const version of ['FluidNC v4.1.1', 'v4.1.1-sim', '4.1.10', '4.2.0', '5.0.0']) {
  assert.equal(supportsSingleBlock(version), true, `${version} must support single block`)
}
const firmwareInfo = {
  version: 'FluidNC v4.1.0', hostname: 'fluidnc.test', authentication: false,
  asyncMode: true, wsPort: 81, wsIp: '', axes: 3, primarySd: '/sd/', secondarySd: '',
}
useMachineStore.getState().setEspInfo(firmwareInfo)
const beforeUnsupportedToggle = socket.sent.length
const beforeUnsupportedRequest = modeRequests.length
block().setMode(true)
assert.equal(block().requestedMode, null)
assert.equal(socket.sent.length, beforeUnsupportedToggle, 'older firmware must not receive $GB')
assert.equal(modeRequests.length, beforeUnsupportedRequest)
useMachineStore.getState().setEspInfo({ ...firmwareInfo, version: 'FluidNC v4.1.1' })
block().setMode(true)
block().setMode(false)
assert.equal(block().requestedMode, true, 'repeated mode clicks must wait for controller confirmation')
await waitFor(() => block().requestedMode === null, 'single block enable was not confirmed')
assert.ok(useMachineStore.getState().status.pinState.includes('Q'))
const cycleStarts = () => socket.sent.filter(item => item instanceof Uint8Array && item[0] === 0x7e).length
socket.receive('[MSG:INFO: Step /sd/test.nc:12 G1 X10]\n')
socket.machineState = 'Hold:1'
socket.reportStatus()
const beforeSteps = cycleStarts()
block().resume()
assert.equal(cycleStarts(), beforeSteps, 'decelerating Hold must not enable Next block')
socket.machineState = 'Hold:0'
socket.reportStatus()
assert.equal(block().ready, true)
assert.equal(block().displayedBlock?.line, 12)
block().resume()
assert.equal(block().displayedBlock?.line, 12, 'the readout must retain the line during motion')
block().resume()
assert.equal(cycleStarts(), beforeSteps + 1, 'double click must release exactly one block')
socket.reportStatus()
block().resume()
assert.equal(cycleStarts(), beforeSteps + 1, 'a stale Hold report must not release another block')

// A modal-only line can advance directly from Hold to Hold, with no Run report.
socket.receive('[MSG:INFO: Step /sd/test.nc:13 G90]\n')
assert.equal(block().advancing, true, 'a preview alone must not unlock cycle start')
socket.reportStatus()
assert.equal(block().advancing, false)
assert.equal(block().pendingBlock?.line, 13)
// Disabling while held may only return the explicit INFO acknowledgment.
socket.reportModeChanges = false
block().setMode(false)
block().resume()
assert.equal(cycleStarts(), beforeSteps + 1, 'resume must wait for mode change confirmation')
await waitFor(() => block().requestedMode === null, 'single block disable was not confirmed')
assert.equal(modeRequests.at(-1)?.command, '$GB=Off', 'Off must bypass the paused job input queue')
assert.ok(!socket.sent.some(item => typeof item === 'string' && /^\$GB=/.test(item)), 'mode changes must never enter the WebSocket job queue')
assert.equal(useMachineStore.getState().status.pinState, '', 'the HTTP disable acknowledgment must clear Q without a status report')
assert.equal(useMachineStore.getState().status.state, 'Hold', 'Off must keep the machine paused')
await delay(4200)
assert.equal(block().error, null, 'a confirmed disable must cancel the timeout')
socket.reportModeChanges = true
socket.reportStatus()
assert.equal(useMachineStore.getState().status.pinState, '', 'omitted Pn must clear Q')
assert.equal(block().pendingBlock?.line, 13, 'turning off must retain the paused line until Resume')
assert.equal(cycleStarts(), beforeSteps + 1, 'turning off must not automatically resume')
block().resume()
assert.equal(cycleStarts(), beforeSteps + 2)
assert.equal(block().pendingBlock, null)

// External pendant resumes and resets must invalidate the pending highlight.
socket.singleBlock = true
socket.receive('[MSG:INFO: Step /sd/test.nc:14 M0]\n')
socket.reportStatus()
block().resume()
assert.equal(block().advancing, true)
socket.receive('[GC:G1 G54 G17 G21 G90 G94 M0 M5 M9 T0 F100 S0]\n')
assert.equal(block().advancing, false, 'explicit M0 must allow an ordinary Resume without a new Step')
const beforeM0Resume = cycleStarts()
block().resume()
assert.equal(cycleStarts(), beforeM0Resume + 1)
socket.machineState = 'Run'
socket.reportStatus()
assert.equal(block().advancing, false, 'a feed hold during motion must remain resumable')
socket.machineState = 'Hold:0'
socket.reportStatus()
const beforeManualResume = cycleStarts()
block().resume()
assert.equal(cycleStarts(), beforeManualResume + 1)
socket.receive('[MSG:INFO: Step /sd/test.nc:14 M3 S1000]\n')
socket.reportStatus()
socket.machineState = 'Run'
socket.reportStatus()
assert.equal(block().pendingBlock, null)
socket.receive('[MSG:INFO: Step /sd/test.nc:15 G1 X20]\n')
socket.machineState = 'Hold:0'
socket.reportStatus()
assert.ok(ws.sendRealtimeNow(0x18))
assert.equal(block().pendingBlock, null)
assert.equal(useMachineStore.getState().status.pinState, '')
socket.singleBlock = false
socket.machineState = 'Idle'
socket.reportStatus()
await waitFor(() => !useMachineStore.getState().controllerResetPending, 'reset cooldown did not finish')

socket.supportsBlockMode = false
block().setMode(true)
await waitFor(() => block().error !== null, 'unsupported block mode did not report a failure', 5000)
assert.equal(useMachineStore.getState().status.pinState, '', 'unsupported firmware must not appear enabled')
assert.equal(block().error, 'Mode change failed (error 3).', 'HTTP command failures must be reported immediately')
block().clearError()
socket.supportsBlockMode = true

// A no-op $GB returns only ok. Its dedicated HTTP response still confirms it.
socket.modeReply = 'ok'
socket.reportModeChanges = false
block().setMode(true)
await waitFor(() => block().requestedMode === null, 'ok-only enable was not confirmed')
assert.ok(useMachineStore.getState().status.pinState.includes('Q'))
block().setMode(false)
await waitFor(() => block().requestedMode === null, 'ok-only disable was not confirmed')
assert.equal(useMachineStore.getState().status.pinState, '')
socket.modeReply = 'silent'
block().setMode(true)
const timedOutRequest = modeRequests.at(-1)!
await waitFor(() => block().error !== null, 'unconfirmed HTTP mode change must time out', 5000)
assert.equal(block().error, 'Mode change timed out.')
assert.equal(timedOutRequest.signal.aborted, true, 'timed out mode requests must be canceled')
block().clearError()
socket.modeReply = 'info'
socket.failModeRequest = true
block().setMode(true)
await waitFor(() => block().error !== null, 'network failure was not reported')
assert.equal(block().error, 'Mode change failed.')
block().clearError()
socket.failModeRequest = false
socket.reportModeChanges = true

const commands = Array.from({ length: 30 }, (_, index) => `G1 X${index} F100`).concat('M30')
socket.bufferedAmount = 2048
assert.equal(useGCodeSenderStore.getState().start(commands.join('\n'), 'window.gcode'), true)
assert.equal(ws.sendRaw('M9'), false, 'normal commands must be rejected while the stream owns ok responses')
block().setMode(true)
assert.equal(block().requestedMode, null, 'mode commands must not enter the local stream acknowledgement lane')
useGCodeSenderStore.getState().pause()
assert.equal(useGCodeSenderStore.getState().phase, 'streaming', 'preparation cannot be stranded in Paused')
await delay(350)

const programMessages = () => socket.sent
  .filter((item): item is string => typeof item === 'string')
  .flatMap(item => item.split('\n').map(line => line.trim()).filter(Boolean))
  .filter(item => item.startsWith('G1 ') || item === 'M30')

const programFrames = () => socket.sent
  .filter((item): item is string => typeof item === 'string')
  .filter(item => item.split('\n').some(line => line.trim().startsWith('G1 ') || line.trim() === 'M30'))

assert.equal(programMessages().length, 0, 'stream must honor browser websocket backpressure')
socket.bufferedAmount = 0
socket.machineState = 'Run'
useMachineStore.getState().updateStatus({ state: 'Run' })
await waitFor(() => programMessages().length > 0, 'stream did not start after backpressure cleared')
assert.ok(
  programFrames().length > 0,
  'program commands must use websocket text frames',
)
assert.ok(
  programFrames().every(frame => frame.trim().split('\n').filter(Boolean).length === 1),
  'program commands should retain per-line framing',
)
const textCommands = socket.sent.filter((item): item is string => typeof item === 'string').map(item => item.trim())
assert.ok(textCommands.indexOf('$RI') < textCommands.indexOf('$RI=0'), 'stream must query the existing report interval before changing it')
assert.ok(textCommands.indexOf('$RI=0') < textCommands.findIndex(command => command.startsWith('G1 ')), 'auto-reporting must be disabled before G-code starts')

let acknowledged = 0
while (acknowledged < commands.length) {
  await waitFor(() => programMessages().length > acknowledged, `command ${acknowledged + 1} was not sent`)
  const sent = programMessages()
  const outstandingBytes = sent.slice(acknowledged)
    .reduce((total, command) => total + new TextEncoder().encode(command).byteLength + 1, 0)
  assert.ok(outstandingBytes <= 127 || sent[acknowledged].length > 127, `stream window overflowed: ${outstandingBytes}`)
  assert.ok(sent.length - acknowledged <= 8, `stream response window overflowed: ${sent.length - acknowledged} blocks`)
  socket.receive('ok\n')
  acknowledged++
}

socket.machineState = 'Idle'
useMachineStore.getState().updateStatus({ state: 'Idle' })
await waitFor(() => useGCodeSenderStore.getState().phase === 'completed', 'acknowledged stream did not complete')
assert.equal(useGCodeSenderStore.getState().completedBlocks, commands.length)
assert.equal(socket.reportInterval, 750, 'stream must restore the exact controller report interval')

useGCodeSenderStore.getState().dismiss()
assert.equal(useGCodeSenderStore.getState().start('G1 X1 F100', 'lost-ack.gcode'), true)
await waitFor(() => programMessages().filter(command => command === 'G1 X1 F100').length === 1, 'lost-ack test block was not sent')
await waitFor(() => useGCodeSenderStore.getState().phase === 'error', 'lost acknowledgement was not detected', 7000)
assert.match(useGCodeSenderStore.getState().error ?? '', /stopped acknowledging/)
assert.equal(socket.reportInterval, 750, 'error cleanup must restore the exact controller report interval')

useGCodeSenderStore.getState().dismiss()
socket.supportsReportInterval = false
const disableCommandsBeforeFallback = socket.sent.filter(item => typeof item === 'string' && item.trim() === '$RI=0').length
assert.equal(useGCodeSenderStore.getState().start('G1 X99 F100', 'legacy.gcode'), true)
await waitFor(() => programMessages().includes('G1 X99 F100'), 'legacy fallback stream did not start')
assert.equal(
  socket.sent.filter(item => typeof item === 'string' && item.trim() === '$RI=0').length,
  disableCommandsBeforeFallback,
  'unsupported firmware must not receive the report-disable command',
)
socket.machineState = 'Run'
useMachineStore.getState().updateStatus({ state: 'Run' })
socket.receive('ok\n')
socket.machineState = 'Idle'
useMachineStore.getState().updateStatus({ state: 'Idle' })
await waitFor(() => useGCodeSenderStore.getState().phase === 'completed', 'legacy fallback stream did not complete')

socket.singleBlock = true
socket.machineState = 'Hold:0'
socket.receive('[MSG:INFO: Step /sd/disconnected.nc:1 G1 X99]\n')
socket.reportStatus()
assert.ok(block().pendingBlock)
block().setMode(false)
const disconnectedRequest = modeRequests.at(-1)!
ws.disconnect()
assert.equal(block().pendingBlock, null, 'disconnect must clear pending program lines')
assert.equal(block().requestedMode, null, 'disconnect must clear pending mode changes')
assert.equal(disconnectedRequest.signal.aborted, true)
await delay(20)
assert.equal(block().error, null, 'late HTTP responses must not resurrect a disconnected session')
assert.equal(useMachineStore.getState().status.pinState, 'Q', 'late HTTP replies must not change the disconnected mode state')
console.log('G-code stream and single-block control tests passed')
