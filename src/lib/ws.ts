import { parseControllerSettingLine, parseGcStateLine, parseStatusReport } from './parser'
import { useMachineStore } from '../store'
import { sendCommand } from './http'

let socket: WebSocket | null = null
// Rejects a connect() still waiting for onopen; disconnect() detaches the
// socket's handlers, so the attempt would otherwise wait for its timeout.
let cancelPendingConnect: (() => void) | null = null

let generation = 0
let lastDisconnectReason: string | null = null

let livenessTimer: ReturnType<typeof setInterval> | null = null
let statusPollTimer: ReturnType<typeof setInterval> | null = null
let gcStatePollTimer: ReturnType<typeof setInterval> | null = null
let backgroundTrafficSuspensions = 0
let responseTrafficSuspensions = 0
let lastResponseProducingSendAt = 0

interface SilentResponseMatcher {
  starts: (line: string) => boolean
  consume: (line: string) => boolean
  done: (line: string) => boolean
}

const isCommandEnd = (line: string) => line === 'ok' || line === 'error' || line.startsWith('error:')

const ALARM_QUERY_SILENT_RESPONSE: SilentResponseMatcher = {
  starts: (line) => /^\d+:\s/.test(line) || /^Active alarm:\s*\d+\s*\([^)]+\)/.test(line),
  consume: (line) => /^\d+:\s/.test(line) || /^Active alarm:\s*\d+\s*\([^)]+\)/.test(line),
  done: isCommandEnd,
}

// $$ lists the numbered settings ($32 laser mode, ...). A refused query
// answers with a bare error, which must end it too.
const isNumberedSettingLine = (line: string) => /^\$\d+=/.test(line)
const SETTINGS_QUERY_SILENT_RESPONSE: SilentResponseMatcher = {
  starts: (line) => isNumberedSettingLine(line) || line.startsWith('error:'),
  consume: isNumberedSettingLine,
  done: isCommandEnd,
}
// FluidNC's $32 follows the active spindle, and M6 can switch between a laser
// and a router, so the settings are read again after a switch.
let settingsQueryPending = false

const GCODE_STATE_QUERY_SILENT_RESPONSE: SilentResponseMatcher = {
  starts: (line) => line.startsWith('[GC:') && line.endsWith(']'),
  consume: (line) => line.startsWith('[GC:') && line.endsWith(']'),
  done: isCommandEnd,
}

function loadStablePageId(): string {
  try {
    const existing = sessionStorage.getItem('fluidui_pageid')
    if (existing && /^\d{4,}$/.test(existing)) return existing
    const fresh = String(Math.floor(Math.random() * 9000) + 1000)
    sessionStorage.setItem('fluidui_pageid', fresh)
    return fresh
  } catch {
    return String(Math.floor(Math.random() * 9000) + 1000)
  }
}
let pageId = loadStablePageId()

interface ConnectionHealth {
  lastPingTime: number
  lastResponseTime: number
  missedPings: number
}

let connectionHealth: ConnectionHealth = {
  lastPingTime: 0,
  lastResponseTime: Date.now(),
  missedPings: 0,
}

type ConnectionHealthCallback = (health: ConnectionHealth) => void
const connectionCallbacks = new Set<ConnectionHealthCallback>()

export function onConnectionHealth(callback: ConnectionHealthCallback): () => void {
  connectionCallbacks.add(callback)
  return () => { connectionCallbacks.delete(callback) }
}

function updateConnectionHealth() {
  connectionCallbacks.forEach(cb => cb({ ...connectionHealth }))
}


interface QueuedCommand {
  command: string
  isRealtime: boolean
  priority: 'normal' | 'high' | 'emergency'
  timestamp: number
  silentResponseMatcher?: SilentResponseMatcher
  acknowledgmentCallback?: () => void
  timeoutMs?: number
}

const commandQueue: QueuedCommand[] = []
let commandProcessor: ReturnType<typeof setInterval> | null = null
const pendingAcknowledgments = new Map<string, { callback: () => void, timeoutId: ReturnType<typeof setTimeout> }>()
const pendingSilentResponses: SilentResponseMatcher[] = []
let activeSilentResponse: SilentResponseMatcher | null = null
let resetReadyTimer: ReturnType<typeof setTimeout> | null = null

const SOFT_RESET_READY_DELAY_MS = 1000

// FluidNC answers a line that starts a file job only when that job ends, and
// reads no further line from this connection until then: a command sent
// meanwhile would run after the job. Realtime bytes still act at once.
// (M6 with a tool-change macro defers its reply too; that is not covered.)
const JOB_RUN_LINE = /^\s*(?:\$(?:SD|LocalFS)\/Run\b|\[ESP(?:220|700)\])/i
// Replies FluidNC still owes for lines sent outside a stream lease, in order.
// Every line gets one ok or error, except the lines a reset drops.
let lineRepliesOwed = 0
// Position of the reply to a file job started from this page among them
// (1 = the next reply), or 0 while this page has started none.
let jobRunReplyAt = 0
// When every reply before the job's own had come.
let jobRunDueAt = 0
// The job showed up in a status report (its SD: progress field).
let jobProgressSeen = false
// Reports showing no job this long after that mean the count went wrong.
const JOB_START_GRACE_MS = 3000
// Silent queries asked for while the job holds the input, sent once it ends.
const silentQueriesAfterJob: Array<{ cmd: string; matcher: SilentResponseMatcher }> = []

function clearSilentResponses() {
  pendingSilentResponses.length = 0
  activeSilentResponse = null
  silentQueriesAfterJob.length = 0
}

function forgetLineReplies() {
  lineRepliesOwed = 0
  jobRunReplyAt = 0
  jobProgressSeen = false
}

function noteLinesSent(text: string) {
  for (const line of text.split(/\r\n|\r|\n/)) {
    lineRepliesOwed++
    if (jobRunReplyAt === 0 && JOB_RUN_LINE.test(line)) {
      jobRunReplyAt = lineRepliesOwed
      jobRunDueAt = Date.now()
      jobProgressSeen = false
    }
  }
}

function sendQueriesHeldForJob() {
  for (const query of silentQueriesAfterJob.splice(0)) sendSilentRaw(query.cmd, query.matcher)
}

/** Ends the hold once the count of replies owed can no longer be trusted. */
function releaseJobInputHold() {
  forgetLineReplies()
  sendQueriesHeldForJob()
}

/** Counts an ok/error reply; true when it is the late reply to the file job this page started. */
function noteLineReply() {
  if (responseTrafficSuspensions > 0 || lineRepliesOwed === 0) return false
  lineRepliesOwed--
  if (jobRunReplyAt === 0) return false
  if (--jobRunReplyAt === 1) jobRunDueAt = Date.now()
  if (jobRunReplyAt > 0) return false
  jobProgressSeen = false
  sendQueriesHeldForJob()
  return true
}

/**
 * True while a file job started from this page ($SD/Run) holds FluidNC's
 * input from this connection. Lines are refused then; realtime bytes are not.
 */
export function isLineInputHeldByJob() {
  return jobRunReplyAt > 0
    || commandQueue.some(command => !command.isRealtime && JOB_RUN_LINE.test(command.command))
}

/** Why sendRaw() refuses a line at this moment, for the message shown to the user. */
export function lineRefusalReason(): string {
  if (isLineInputHeldByJob()) return 'FluidNC would run it only after the SD job ends'
  if (responseTrafficSuspensions > 0) return 'a G-code stream from this page owns the connection'
  if (useMachineStore.getState().controllerResetPending) return 'a controller reset is in progress'
  if (socket?.readyState !== WebSocket.OPEN) return 'not connected to the controller'
  return 'the controller is not accepting commands right now'
}

function beginSoftResetCooldown() {
  if (resetReadyTimer) clearTimeout(resetReadyTimer)
  // A reset cancels controller work. Do not let ordinary commands that were
  // queued before it (or a new Start clicked immediately after it) run later.
  for (let index = commandQueue.length - 1; index >= 0; index--) {
    if (!commandQueue[index].isRealtime) commandQueue.splice(index, 1)
  }
  // It also ends a file job and drops the lines FluidNC has not answered.
  forgetLineReplies()
  useMachineStore.getState().setControllerResetPending(true)
  resetReadyTimer = setTimeout(() => {
    resetReadyTimer = null
    useMachineStore.getState().setControllerResetPending(false)
    sendQueriesHeldForJob()
  }, SOFT_RESET_READY_DELAY_MS)
}

export interface ExclusiveCommandResult {
  outcome: 'ok' | 'error' | 'timeout' | 'disconnected' | 'unavailable'
  lines: string[]
}

interface PendingExclusiveCommand {
  lines: string[]
  resolve: (result: ExclusiveCommandResult) => void
  timeoutId: ReturnType<typeof setTimeout>
}

let pendingExclusiveCommand: PendingExclusiveCommand | null = null

function settleExclusiveCommand(outcome: ExclusiveCommandResult['outcome']) {
  const pending = pendingExclusiveCommand
  if (!pending) return
  pendingExclusiveCommand = null
  clearTimeout(pending.timeoutId)
  pending.resolve({ outcome, lines: [...pending.lines] })
}

function startCommandProcessor() {
  if (commandProcessor) return
  commandProcessor = setInterval(processCommandQueue, 10)
}

function stopCommandProcessor() {
  if (commandProcessor) {
    clearInterval(commandProcessor)
    commandProcessor = null
  }
}

function processCommandQueue() {
  if (commandQueue.length === 0 || socket?.readyState !== WebSocket.OPEN) return

  commandQueue.sort((a, b) => {
    const order = { emergency: 0, high: 1, normal: 2 }
    const diff = order[a.priority] - order[b.priority]
    return diff !== 0 ? diff : a.timestamp - b.timestamp
  })

  const command = commandQueue.shift()
  if (!command) return

  try {
    if (command.isRealtime) {
      const buf = new Uint8Array(1)
      buf[0] = parseInt(command.command)
      socket!.send(buf)
      if (buf[0] === 0x18) {
        beginSoftResetCooldown()
        softResetHandlers.forEach(handler => handler())
      }
    } else {
      socket!.send(command.command + '\n')
      lastResponseProducingSendAt = Date.now()
      noteLinesSent(command.command)
    }
  } catch {
    // Socket transitioned mid-send — drop quietly; reconnect handles it.
    return
  }

  if (command.silentResponseMatcher) {
    pendingSilentResponses.push(command.silentResponseMatcher)
  }

  if (command.acknowledgmentCallback) {
    const ackKey = `${command.command}_${command.timestamp}`
    const timeoutId = setTimeout(() => {
      pendingAcknowledgments.delete(ackKey)
    }, command.timeoutMs || 5000)
    pendingAcknowledgments.set(ackKey, { callback: command.acknowledgmentCallback, timeoutId })
  }
}

// Jog cancel only ever stops a jog, so it is the one command kept while the
// socket is down: a jog that kept running through the drop still stops once
// the connection returns.
const JOG_CANCEL_BYTE = 0x85

function queueCommand(command: QueuedCommand) {
  if (!command.isRealtime && isLineInputHeldByJob()) return false
  if (socket?.readyState !== WebSocket.OPEN) {
    // Anything else issued while disconnected must not run on its own after a
    // reconnect (a typed G0, a cycle start on a held job, a jog).
    if (!command.isRealtime || Number(command.command) !== JOG_CANCEL_BYTE) return false
    if (commandQueue.some(queued => queued.isRealtime && queued.command === command.command)) return false
  }
  commandQueue.push(command)
  return true
}

type LineHandler = (line: string) => void
const lineHandlers = new Set<LineHandler>()
type SoftResetHandler = () => void
const softResetHandlers = new Set<SoftResetHandler>()
type SessionTakenHandler = () => void
const sessionTakenHandlers = new Set<SessionTakenHandler>()
const TAB_COORDINATION_CHANNEL = 'fluidui-tab-coordination-v1'
const TAB_ACTIVE_MESSAGE = 'tab-active'
let tabCoordinationChannel: BroadcastChannel | null = null
let announcedThisPage = false

export const getPageId = () => pageId

export function onLine(fn: LineHandler): () => void {
  lineHandlers.add(fn)
  return () => { lineHandlers.delete(fn) }
}

export function onSoftReset(fn: SoftResetHandler): () => void {
  softResetHandlers.add(fn)
  return () => { softResetHandlers.delete(fn) }
}

/** Called when FluidNC reports that another browser page became the active UI. */
export function onSessionTaken(fn: SessionTakenHandler): () => void {
  sessionTakenHandlers.add(fn)
  return () => { sessionTakenHandlers.delete(fn) }
}

function notifySessionTaken() {
  sessionTakenHandlers.forEach(fn => fn())
}

function announceActiveTab() {
  if (announcedThisPage) return
  announcedThisPage = true

  // Portability FluidNC can give each tab an independent websocket, but
  // doing so suppresses its same-cookie activeID notification. Preserve that
  // within this browser so an older tab can stop a local stream.
  if (typeof window.BroadcastChannel !== 'function') return
  tabCoordinationChannel ??= new window.BroadcastChannel(TAB_COORDINATION_CHANNEL)
  tabCoordinationChannel.onmessage = event => {
    if (event.data === TAB_ACTIVE_MESSAGE) notifySessionTaken()
  }
  tabCoordinationChannel.postMessage(TAB_ACTIVE_MESSAGE)
}

const LIVENESS_CHECK_MS = 2000
const LIVENESS_TIMEOUT_MS = 12000
const OPEN_TIMEOUT_MS = 6000
export const STATUS_POLL_INTERVAL_MS = 500
const STREAM_STATUS_POLL_INTERVAL_MS = 250
const GC_STATE_POLL_INTERVAL_MS = 2000
// 0x3F = '?' — FluidNC's real-time status request byte.
const STATUS_REPORT_BYTE = 0x3F

export function connect(host: string): Promise<void> {
  return new Promise((resolve, reject) => {

    closeCurrentSocket()
    generation++
    const myGen = generation

    let ws: WebSocket
    // ws: from https is mixed content. Tests and other non-browser hosts have no location.
    const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL(host.includes('/') ? `${scheme}://${host}` : `${scheme}://${host}/`)
    url.searchParams.set('independent_session', '1')
    try {
      ws = new WebSocket(url.toString(), 'arduino')
    } catch (e) {
      reject(e instanceof Error ? e : new Error('WebSocket constructor failed'))
      return
    }
    ws.binaryType = 'arraybuffer'
    socket = ws

    let settled = false
    const openTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      // Mark generation stale so any late onopen/onerror is ignored.
      if (socket === ws) {
        try { ws.close() } catch { /* noop */ }
      }
      reject(new Error('WebSocket connection timed out'))
    }, OPEN_TIMEOUT_MS)
    cancelPendingConnect = () => {
      if (settled) return
      settled = true
      clearTimeout(openTimeout)
      reject(new Error('WebSocket closed before opening'))
    }

    ws.onopen = () => {
      if (myGen !== generation || settled) return
      settled = true
      clearTimeout(openTimeout)

      connectionHealth.lastResponseTime = Date.now()
      lastDisconnectReason = null
      connectionHealth.missedPings = 0
      updateConnectionHealth()

      useMachineStore.getState().setConnected(true)
      startCommandProcessor()
      startLivenessWatchdog()
      startStatusPoll()
      startGcStatePoll()
      announceActiveTab()

      resolve()
    }

    ws.onclose = (event) => {
      if (myGen !== generation) return
      const silentForMs = Math.max(0, Date.now() - connectionHealth.lastResponseTime)
      const closeDetail = event.code === 1006
        ? 'abnormal close without a controller close frame'
        : event.wasClean ? 'clean close' : 'unclean close'
      const transportDetail = `last controller traffic ${silentForMs} ms earlier; browser queue ${ws.bufferedAmount} bytes`
      lastDisconnectReason = event.reason
        ? `WebSocket closed (${event.code}: ${event.reason}; ${closeDetail}; ${transportDetail})`
        : `WebSocket closed (${event.code}: ${closeDetail}; ${transportDetail})`
      handleDisconnect()
      if (!settled) {
        settled = true
        clearTimeout(openTimeout)
        reject(new Error('WebSocket closed before opening'))
      }
    }

    ws.onerror = () => {
      if (myGen !== generation) return
      // Don't tear down here — onclose will follow and do the cleanup.
      if (!settled) {
        settled = true
        clearTimeout(openTimeout)
        try { ws.close() } catch { /* noop */ }
        reject(new Error(`WebSocket error connecting to ${url.toString()}`))
      }
    }

    ws.onmessage = (ev) => {
      if (myGen !== generation) return
      const text =
        ev.data instanceof ArrayBuffer
          ? new TextDecoder().decode(ev.data)
          : String(ev.data)
      text.split('\n').forEach(raw => {
        const line = raw.trim()
        if (line) handleLine(line)
      })
    }
  })
}

function handleDisconnect() {
  stopLivenessWatchdog()
  stopStatusPoll()
  stopGcStatePoll()
  stopCommandProcessor()
  // Drop pending acks — they'll never resolve now.
  pendingAcknowledgments.forEach(({ timeoutId }) => clearTimeout(timeoutId))
  pendingAcknowledgments.clear()
  clearSilentResponses()
  // A new connection is a new FluidNC channel, which no job holds.
  forgetLineReplies()
  settleExclusiveCommand('disconnected')
  // Drop queued commands — sending them on a future reconnect would be
  // surprising (e.g. queued jog moves shouldn't auto-resume).
  commandQueue.length = 0
  if (useMachineStore.getState().connected) {
    useMachineStore.getState().setConnected(false)
  }
}

function closeCurrentSocket() {
  const stale = socket
  if (!stale) return
  // Detach all handlers so the close event can't double-fire downstream.
  stale.onopen = null
  stale.onclose = null
  stale.onerror = null
  stale.onmessage = null
  socket = null
  try { stale.close() } catch { /* noop */ }
  // Replies to lines sent on the old socket can never arrive.
  clearSilentResponses()
  forgetLineReplies()
  // No need to call handleDisconnect() — generation bump prevents stale
  // events, and the caller (connect or disconnect) owns post-close cleanup.
}

function startStatusPoll() {
  if (backgroundTrafficSuspensions > 0) return
  stopStatusPoll()
  // During a local stream FigUI disables FluidNC's 5 Hz auto-reporting and
  // becomes the sole status producer. A 4 Hz poll keeps the DRO, toolhead, and
  // Door/Hold detection responsive while staying below the controller's
  // 32-message queue during AsyncTCP's five-second acknowledgement window,
  // with margin for in-flight G-code acknowledgements and keepalive traffic.
  const interval = responseTrafficSuspensions > 0
    ? STREAM_STATUS_POLL_INTERVAL_MS
    : STATUS_POLL_INTERVAL_MS
  statusPollTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return
    try {
      const buf = new Uint8Array(1)
      buf[0] = STATUS_REPORT_BYTE
      socket.send(buf)
    } catch {
      // Liveness watchdog will catch a dead socket.
    }
  }, interval)
}

function stopStatusPoll() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null }
}

function startGcStatePoll() {
  if (backgroundTrafficSuspensions > 0 || responseTrafficSuspensions > 0) return
  stopGcStatePoll()
  const tick = () => {
    // During a job started here it would only wait in FluidNC's input queue.
    if (socket?.readyState !== WebSocket.OPEN || isLineInputHeldByJob()) return
    if (settingsQueryPending && sendSilentRaw('$$', SETTINGS_QUERY_SILENT_RESPONSE)) settingsQueryPending = false
    sendSilentRaw('$G', GCODE_STATE_QUERY_SILENT_RESPONSE)
  }
  tick()
  gcStatePollTimer = setInterval(tick, GC_STATE_POLL_INTERVAL_MS)
}

function stopGcStatePoll() {
  if (gcStatePollTimer) { clearInterval(gcStatePollTimer); gcStatePollTimer = null }
}

function startLivenessWatchdog() {
  if (backgroundTrafficSuspensions > 0) return
  stopLivenessWatchdog()
  livenessTimer = setInterval(() => {
    if (!socket) return
    const ws = socket
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      // Browser hasn't fired onclose for some reason — force the cleanup.
      handleDisconnect()
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    const silentFor = Date.now() - connectionHealth.lastResponseTime
    if (silentFor > LIVENESS_TIMEOUT_MS) {
      // Connection is dead — terminate so the App-level reconnect kicks in.
      // Bump generation first so the impending onclose is ignored as stale,
      // then run the cleanup ourselves.
      generation++
      lastDisconnectReason = `No controller traffic for ${Math.round(LIVENESS_TIMEOUT_MS / 1000)} seconds`
      try { ws.close() } catch { /* noop */ }
      socket = null
      handleDisconnect()
    }
  }, LIVENESS_CHECK_MS)
}

function stopLivenessWatchdog() {
  if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null }
}

function consumeSilentLine(line: string): boolean {
  if (!activeSilentResponse && pendingSilentResponses.length > 0) {
    const nextSilentResponse = pendingSilentResponses[0]
    if (nextSilentResponse.starts(line)) {
      activeSilentResponse = nextSilentResponse
    }
  }

  if (!activeSilentResponse) return false

  const shouldConsume = activeSilentResponse.consume(line)
  const isDone = activeSilentResponse.done(line)

  if (isDone) {
    pendingSilentResponses.shift()
    activeSilentResponse = null
  }

  return shouldConsume || isDone
}

// ──────────────────────────────────────────────────────────────────────────
// Inbound line handling
// ──────────────────────────────────────────────────────────────────────────

type ProbeCapabilityReport = { kind: 'probe' | 'toolsetter'; enabled: boolean }

function parseProbeCapabilityLine(line: string): ProbeCapabilityReport | null {
  const match = line.match(/^\[MSG:INFO:\s*(Probe|Toolsetter)(?:\s+Pin:)?\s+(.+?)\]$/i)
  if (!match) return null
  const pin = match[2].trim().replace(/[\s_-]+/g, '').toUpperCase()
  return {
    kind: match[1].toLowerCase() as ProbeCapabilityReport['kind'],
    enabled: pin !== '' && pin !== 'NOPIN' && pin !== 'VOID',
  }
}

function isManualATCCapabilityLine(line: string) {
  return /^\[MSG:INFO:\s*ATC:\s*atc_manual\s*\]$/i.test(line)
}

function handleLine(line: string) {
  connectionHealth.lastResponseTime = Date.now()
  if (connectionHealth.missedPings !== 0) {
    connectionHealth.missedPings = 0
  }
  updateConnectionHealth()

  if (line.startsWith('currentID:')) { pageId = line.slice(10); persistPageId(); return }
  if (line.startsWith('CURRENT_ID:')) { pageId = line.slice(11); persistPageId(); return }
  if (line.startsWith('activeID:') || line.startsWith('ACTIVE_ID:')) {
    notifySessionTaken()
    return
  }
  if (line === 'PING' || line.startsWith('PING:')) {
    // FluidNC sends its own websocket keepalive. Realtime status reports are
    // the application liveness signal, so a response-producing client ping is
    // unnecessary and would compete with G-code acknowledgements.
    return
  }
  // FluidNC greets every channel after any reset (a pendant, another client,
  // an alarm), which ends a file job and drops the reply to the line it ran.
  if (line.startsWith('Grbl ') && line.includes('[FluidNC')) releaseJobInputHold()
  if (/Changed to spindle:/i.test(line)) settingsQueryPending = true

  // Stream setup/teardown commands temporarily own the response lane. Status
  // reports remain live, but their terminal response must never be mistaken
  // for a program-block acknowledgement.
  if (pendingExclusiveCommand && !(line.startsWith('<') && line.endsWith('>'))) {
    pendingExclusiveCommand.lines.push(line)
    if (line === 'ok') {
      settleExclusiveCommand('ok')
      return
    }
    if (line === 'error' || line.startsWith('error:')) {
      settleExclusiveCommand('error')
      return
    }
  }

  // The late reply to $SD/Run belongs to no query sent since.
  const jobRunReply = isCommandEnd(line) && noteLineReply()
  const isSilentLine = !jobRunReply && consumeSilentLine(line)

  if (line.startsWith('<') && line.endsWith('>')) {
    // Reports carry the SD: field exactly while a file job runs. Its end
    // releases the input even if a lost reply left the count behind, and so
    // does a job that never shows although only its own reply is owed (a
    // refused file whose error was taken for the lost reply).
    if (jobRunReplyAt > 0) {
      if (line.includes('|SD:')) jobProgressSeen = true
      else if (jobProgressSeen || (jobRunReplyAt === 1 && /^<(?:Idle|Alarm)/.test(line)
        && Date.now() - jobRunDueAt >= JOB_START_GRACE_MS)) releaseJobInputHold()
    }
    const parsed = parseStatusReport(line, {
      reportInches: useMachineStore.getState().controllerSettings.reportInches,
    })
    if (parsed) {
      useMachineStore.getState().updateStatus(parsed)
      useMachineStore.getState().setStatusReceived(true)
    }
    lineHandlers.forEach(fn => fn(line))
    return
  }

  const gcState = parseGcStateLine(line)
  if (gcState) {
    useMachineStore.getState().updateStatus(gcState)
    if (isSilentLine) return
    lineHandlers.forEach(fn => fn(line))
    return
  }

  const controllerSettings = parseControllerSettingLine(line)
  if (controllerSettings) {
    useMachineStore.getState().updateControllerSettings(controllerSettings)
    if (isSilentLine) return
    lineHandlers.forEach(fn => fn(line))
    return
  }

  const probeCapability = parseProbeCapabilityLine(line)
  if (probeCapability) {
    useMachineStore.getState().updateControllerSettings(probeCapability.kind === 'probe'
      ? { hasProbe: probeCapability.enabled }
      : { hasToolsetter: probeCapability.enabled })
  }

  if (isManualATCCapabilityLine(line)) {
    useMachineStore.getState().updateControllerSettings({ hasManualATC: true })
  }

  if (!jobRunReply && (line === 'ok' || line === 'error')) {
    for (const [ackKey, ackData] of pendingAcknowledgments.entries()) {
      clearTimeout(ackData.timeoutId)
      ackData.callback()
      pendingAcknowledgments.delete(ackKey)
      break
    }
  }

  const alarmMatch = line.match(/^Active alarm:\s*(\d+)\s*\(([^)]+)\)/)
  if (alarmMatch) {
    useMachineStore.getState().updateStatus({
      state: 'Alarm',
      alarmCode: parseInt(alarmMatch[1], 10),
      alarmName: alarmMatch[2],
    })
    if (isSilentLine) return
    lineHandlers.forEach(fn => fn(line))
    return
  }

  const alarmCodeMatch = line.match(/^ALARM:(\d+)$/)
  if (alarmCodeMatch) {
    useMachineStore.getState().updateStatus({
      state: 'Alarm',
      alarmCode: parseInt(alarmCodeMatch[1], 10),
    })
    if (isSilentLine) return
    lineHandlers.forEach(fn => fn(line))
    return
  }

  const msgAlarmMatch = line.match(/\[MSG:INFO:\s*ALARM:\s*(.+?)\]/)
  if (msgAlarmMatch) {
    useMachineStore.getState().updateStatus({
      state: 'Alarm',
      alarmName: msgAlarmMatch[1].trim(),
    })
    if (isSilentLine) return
    lineHandlers.forEach(fn => fn(line))
    return
  }

  if (isSilentLine) return

  if (line.startsWith('{"EEPROM":') || line.startsWith('{"cmd":"400"')) return

  lineHandlers.forEach(fn => fn(line))
}

function persistPageId() {
  try { sessionStorage.setItem('fluidui_pageid', pageId) } catch { /* noop */ }
}

// ──────────────────────────────────────────────────────────────────────────
// Public send API
// ──────────────────────────────────────────────────────────────────────────

export function sendRaw(cmd: string) {
  // An acknowledged G-code stream owns the normal response channel. Letting a
  // terminal, plugin, or UI command enter the queue here would make its `ok`
  // indistinguishable from a program-block acknowledgement. During an SD job
  // started here, or while disconnected, queueCommand refuses it.
  if (responseTrafficSuspensions > 0 || useMachineStore.getState().controllerResetPending) return false
  return queueCommand({ command: cmd, isRealtime: false, priority: 'normal', timestamp: Date.now() })
}

/** Send one acknowledged program block immediately while response traffic is suspended. */
export function sendStreamRaw(cmd: string) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(cmd + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * Send a controller command while an acknowledged stream owns the response
 * lane. Only stream setup/teardown may use this, and no program blocks may be
 * outstanding. Its terminal response is consumed here instead of reaching the
 * G-code sender's FIFO acknowledgement handler.
 */
export function sendExclusiveResponseCommand(cmd: string, timeoutMs = 1500): Promise<ExclusiveCommandResult> {
  if (
    responseTrafficSuspensions === 0
    || pendingExclusiveCommand
    || socket?.readyState !== WebSocket.OPEN
  ) {
    return Promise.resolve({ outcome: 'unavailable', lines: [] })
  }

  return new Promise(resolve => {
    const timeoutId = setTimeout(() => settleExclusiveCommand('timeout'), timeoutMs)
    pendingExclusiveCommand = { lines: [], resolve, timeoutId }
    try {
      socket!.send(cmd + '\n')
      lastResponseProducingSendAt = Date.now()
    } catch {
      settleExclusiveCommand('disconnected')
    }
  })
}

/**
 * Browser-side websocket backpressure. `send()` only means that a frame was
 * accepted into the browser queue; it does not mean it has reached FluidNC.
 */
export function isStreamTransportWritable(maxBufferedBytes = 1024) {
  return socket?.readyState === WebSocket.OPEN && socket.bufferedAmount <= maxBufferedBytes
}

export function sendSilentRaw(cmd: string, silentResponseMatcher: SilentResponseMatcher) {
  if (responseTrafficSuspensions > 0) return false
  // FluidNC would only queue it behind the job, so it waits for the job to
  // end here instead (an alarm's $A, once the alarm has ended the job).
  if (isLineInputHeldByJob()) {
    if (socket?.readyState !== WebSocket.OPEN) return false
    if (!silentQueriesAfterJob.some(query => query.cmd === cmd)) {
      silentQueriesAfterJob.push({ cmd, matcher: silentResponseMatcher })
    }
    return true
  }
  return queueCommand({
    command: cmd,
    isRealtime: false,
    priority: 'normal',
    timestamp: Date.now(),
    silentResponseMatcher,
  })
}

export function sendSilentAlarmQuery() {
  return sendSilentRaw('$A', ALARM_QUERY_SILENT_RESPONSE)
}

export function suspendBackgroundTraffic() {
  backgroundTrafficSuspensions++
  stopStatusPoll()
  stopGcStatePoll()
  stopLivenessWatchdog()
}

export function resumeBackgroundTraffic() {
  backgroundTrafficSuspensions = Math.max(0, backgroundTrafficSuspensions - 1)
  if (backgroundTrafficSuspensions > 0 || socket?.readyState !== WebSocket.OPEN) return
  // A long controller-side operation may legitimately have produced no
  // websocket traffic. Start its liveness window again from this point.
  connectionHealth.lastResponseTime = Date.now()
  startStatusPoll()
  startGcStatePoll()
  startLivenessWatchdog()
}

/**
 * Pause only background commands that generate `ok` responses. Realtime
 * status polling remains active, which lets an acknowledged G-code stream
 * track Run/Hold/Idle without mistaking query acknowledgements for job lines.
 */
export function suspendResponseTraffic() {
  responseTrafficSuspensions++
  stopGcStatePoll()
  if (socket?.readyState === WebSocket.OPEN) startStatusPoll()
}

/**
 * True once commands sent before the stream lease have had time to finish.
 * The quiet interval covers ordinary `sendRaw()` commands, whose responses are
 * intentionally not consumed by an internal matcher.
 */
export function isResponseTrafficQuiescent(quietMs = 500) {
  return commandQueue.length === 0
    && pendingAcknowledgments.size === 0
    && pendingSilentResponses.length === 0
    && activeSilentResponse === null
    && !isLineInputHeldByJob()
    && silentQueriesAfterJob.length === 0
    && pendingExclusiveCommand === null
    && Date.now() - lastResponseProducingSendAt >= quietMs
}

export function resumeResponseTraffic() {
  responseTrafficSuspensions = Math.max(0, responseTrafficSuspensions - 1)
  if (
    responseTrafficSuspensions > 0
    || backgroundTrafficSuspensions > 0
    || socket?.readyState !== WebSocket.OPEN
  ) return
  connectionHealth.lastResponseTime = Date.now()
  startStatusPoll()
  startGcStatePoll()
}


export async function sendStartupQueries(canContinue: () => boolean = () => true): Promise<boolean> {
  if (!canContinue()) return false
  try {
    const ssText = await sendCommand('$SS')
    if (!canContinue()) return false
    const hasMist  = /\[MSG:INFO:\s*Mist coolant/i.test(ssText)
    const hasFlood = /\[MSG:INFO:\s*Flood coolant/i.test(ssText)
    const hasManualATC = ssText.split('\n').some(raw => isManualATCCapabilityLine(raw.trim()))
    if (hasMist || hasFlood) useMachineStore.getState().updateControllerSettings({ hasMist, hasFlood })
    const probeReports = ssText.split('\n')
      .map(raw => parseProbeCapabilityLine(raw.trim()))
      .filter((value): value is ProbeCapabilityReport => value != null)
    useMachineStore.getState().updateControllerSettings({
      hasProbe: probeReports.some(report => report.kind === 'probe' && report.enabled),
      hasToolsetter: probeReports.some(report => report.kind === 'toolsetter' && report.enabled),
      hasManualATC,
    })
    ssText.split('\n').forEach(raw => {
      const line = raw.trim()
      if (line) lineHandlers.forEach(fn => fn(line))
    })
  } catch { /* noop */ }

  if (!canContinue()) return false
  try {
    const settingsText = await sendCommand('$$')
    if (!canContinue()) return false
    settingsText.split('\n').forEach(raw => {
      const line = raw.trim()
      if (!line) return
      const settings = parseControllerSettingLine(line)
      if (settings) {
        useMachineStore.getState().updateControllerSettings(settings)
      }
    })
  } catch { /* noop */ }
  return canContinue()
}

export function sendRealtime(byte: number) {
  // Unlike other realtime inputs, Ctrl-X changes local safety state. Do not
  // queue it or show a reset cooldown unless it can actually be sent.
  if (byte === 0x18 && socket?.readyState !== WebSocket.OPEN) return false
  const queued = queueCommand({
    command: byte.toString(),
    isRealtime: true,
    priority: byte === 0x18 ? 'emergency' : 'normal',
    timestamp: Date.now(),
  })
  return queued && socket?.readyState === WebSocket.OPEN
}

/** Best-effort immediate realtime byte, for stream ordering and page lifecycle safety. */
export function sendRealtimeNow(byte: number) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(Uint8Array.of(byte))
    if (byte === 0x18) {
      beginSoftResetCooldown()
      softResetHandlers.forEach(handler => handler())
    }
    return true
  } catch {
    return false
  }
}

export function sendPriorityCancel(): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (ok: boolean) => { if (!resolved) { resolved = true; resolve(ok) } }
    queueCommand({
      command: '133',
      isRealtime: true,
      priority: 'high',
      timestamp: Date.now(),
      acknowledgmentCallback: () => done(true),
      timeoutMs: 1000,
    })
    setTimeout(() => done(false), 1000)
  })
}

export function sendBurstCancel(): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    let completed = 0
    const expected = 5
    const done = (ok: boolean) => { if (!resolved) { resolved = true; resolve(ok) } }
    for (let i = 0; i < expected; i++) {
      queueCommand({
        command: '133',
        isRealtime: true,
        priority: 'high',
        timestamp: Date.now() + i,
        acknowledgmentCallback: () => { if (++completed >= expected) done(true) },
        timeoutMs: 1000,
      })
    }
    setTimeout(() => done(false), 2000)
  })
}

export function sendAggressiveBurstCancel(): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    let completed = 0
    const expected = 10
    const done = (ok: boolean) => { if (!resolved) { resolved = true; resolve(ok) } }
    for (let i = 0; i < expected; i++) {
      queueCommand({
        command: '133',
        isRealtime: true,
        priority: 'emergency',
        timestamp: Date.now() + i,
        acknowledgmentCallback: () => { if (++completed >= expected) done(true) },
        timeoutMs: 500,
      })
    }
    setTimeout(() => done(false), 1000)
  })
}

export function getConnectionHealth(): ConnectionHealth {
  return { ...connectionHealth }
}

export function isSocketOpen(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

export function getLastDisconnectReason(): string | null {
  return lastDisconnectReason
}

export function disconnect() {
  generation++
  backgroundTrafficSuspensions = 0
  responseTrafficSuspensions = 0
  stopLivenessWatchdog()
  stopStatusPoll()
  stopGcStatePoll()
  stopCommandProcessor()
  clearSilentResponses()
  settleExclusiveCommand('disconnected')
  pendingAcknowledgments.forEach(({ timeoutId }) => clearTimeout(timeoutId))
  pendingAcknowledgments.clear()
  commandQueue.length = 0
  cancelPendingConnect?.()
  cancelPendingConnect = null
  closeCurrentSocket()
  if (useMachineStore.getState().connected) {
    useMachineStore.getState().setConnected(false)
  }
}
