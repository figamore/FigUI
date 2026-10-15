import { parseControllerSettingLine, parseGcStateLine, parseStatusReport } from './parser'
import { useMachineStore } from '../store'
import { sendCommand } from './http'
import type { MachineStatus } from '../types'

let socket: WebSocket | null = null

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

const ALARM_QUERY_SILENT_RESPONSE: SilentResponseMatcher = {
  starts: (line) => /^\d+:\s/.test(line) || /^Active alarm:\s*\d+\s*\([^)]+\)/.test(line),
  consume: (line) => /^\d+:\s/.test(line) || /^Active alarm:\s*\d+\s*\([^)]+\)/.test(line),
  done: (line) => line === 'ok' || line === 'error',
}

const GCODE_STATE_QUERY_SILENT_RESPONSE: SilentResponseMatcher = {
  starts: (line) => line.startsWith('[GC:') && line.endsWith(']'),
  consume: (line) => line.startsWith('[GC:') && line.endsWith(']'),
  done: (line) => line === 'ok' || line === 'error',
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
// Silent queries sent before the last reset that are still waiting for a reply.
let silentResponsesBeforeReset = 0
// Silent queries asked for during the reset cooldown, queued once it ends.
const silentQueriesAfterReset: QueuedCommand[] = []

const SOFT_RESET_READY_DELAY_MS = 1000

function beginSoftResetCooldown() {
  if (resetReadyTimer) clearTimeout(resetReadyTimer)
  // A reset cancels controller work. Do not let ordinary commands that were
  // queued before it (or a new Start clicked immediately after it) run later.
  for (let index = commandQueue.length - 1; index >= 0; index--) {
    if (!commandQueue[index].isRealtime) commandQueue.splice(index, 1)
  }
  useMachineStore.getState().setControllerResetPending(true)
  // FluidNC drops commands it has not answered yet when it resets. Replies
  // already on their way get until the cooldown ends; after that the queries
  // are forgotten, or every later reply would be credited to the query
  // before it and a local stream could never start.
  silentResponsesBeforeReset = pendingSilentResponses.length
  resetReadyTimer = setTimeout(() => {
    resetReadyTimer = null
    if (silentResponsesBeforeReset > 0) {
      pendingSilentResponses.splice(0, silentResponsesBeforeReset)
      activeSilentResponse = null
      silentResponsesBeforeReset = 0
    }
    commandQueue.push(...silentQueriesAfterReset.splice(0))
    useMachineStore.getState().setControllerResetPending(false)
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

function queueCommand(command: QueuedCommand) {
  commandQueue.push(command)
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
const LIVENESS_LATE_CHECK_MS = 3 * LIVENESS_CHECK_MS
const LIVENESS_RESUME_GRACE_MS = 6000
const OPEN_TIMEOUT_MS = 6000
export const STATUS_POLL_INTERVAL_MS = 500
const STREAM_STATUS_POLL_INTERVAL_MS = 250
const GC_STATE_POLL_INTERVAL_MS = 2000
const GC_STATE_FALLBACK_POLL_MS = 30000
// 0x3F = '?' — FluidNC's real-time status request byte.
const STATUS_REPORT_BYTE = 0x3F

// FluidNC auto-reports status to websocket clients every 200 ms while the
// machine moves and pushes [GC:] whenever the modal state changes. Polling on
// top of that only adds controller load, so both polls stand aside while
// those reports arrive. Each '?' gets one reply, so a second report between
// two polls means the controller is reporting on its own; in Idle and Hold,
// or with auto-reporting off, polling carries on as before.
let statusReportsSincePoll = 0
let autoReportSeenAt = 0
// Last [GC:] line, pushed or asked for; the fallback $G only runs without one.
let lastGcStateAt = 0

export function connect(host: string): Promise<void> {
  return new Promise((resolve, reject) => {

    closeCurrentSocket()
    generation++
    const myGen = generation

    let ws: WebSocket
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'  // ws: from https is mixed content
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
  flushStatusReport()
  stopLivenessWatchdog()
  stopStatusPoll()
  stopGcStatePoll()
  stopCommandProcessor()
  // Drop pending acks — they'll never resolve now.
  pendingAcknowledgments.forEach(({ timeoutId }) => clearTimeout(timeoutId))
  pendingAcknowledgments.clear()
  pendingSilentResponses.length = 0
  activeSilentResponse = null
  settleExclusiveCommand('disconnected')
  // Drop queued commands — sending them on a future reconnect would be
  // surprising (e.g. queued jog moves shouldn't auto-resume).
  commandQueue.length = 0
  silentQueriesAfterReset.length = 0
  silentResponsesBeforeReset = 0
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
  statusReportsSincePoll = 0
  statusPollTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return
    const autoReporting = statusReportsSincePoll >= 2
    statusReportsSincePoll = 0
    if (autoReporting && responseTrafficSuspensions === 0) {
      autoReportSeenAt = Date.now()
      return
    }
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
    if (socket?.readyState !== WebSocket.OPEN) return
    sendSilentRaw('$G', GCODE_STATE_QUERY_SILENT_RESPONSE)
  }
  autoReportSeenAt = 0
  tick()
  gcStatePollTimer = setInterval(() => {
    // While auto-reports arrive, $G only runs when no [GC:] came for a while.
    const now = Date.now()
    if (
      now - autoReportSeenAt < GC_STATE_POLL_INTERVAL_MS
      && now - lastGcStateAt < GC_STATE_FALLBACK_POLL_MS
    ) return
    lastGcStateAt = now
    tick()
  }, GC_STATE_POLL_INTERVAL_MS)
}

function stopGcStatePoll() {
  if (gcStatePollTimer) { clearInterval(gcStatePollTimer); gcStatePollTimer = null }
}

function startLivenessWatchdog() {
  if (backgroundTrafficSuspensions > 0) return
  stopLivenessWatchdog()
  let checkedAt = Date.now()
  let graceGiven = false
  livenessTimer = setInterval(() => {
    if (!socket) return
    const ws = socket
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      // Browser hasn't fired onclose for some reason — force the cleanup.
      handleDisconnect()
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    const late = now - checkedAt > LIVENESS_LATE_CHECK_MS
    if (connectionHealth.lastResponseTime >= checkedAt) graceGiven = false
    checkedAt = now
    const silentFor = now - connectionHealth.lastResponseTime
    // A late check means the page was paused (a frozen or throttled tab, a
    // phone waking up, an open dialog), so this silence was not measured and
    // the replies may still be queued behind this tick. Ask for a report and
    // judge again shortly; a second late check with nothing heard is final.
    if (silentFor > LIVENESS_TIMEOUT_MS && late && !graceGiven) {
      graceGiven = true
      connectionHealth.lastResponseTime = now - LIVENESS_TIMEOUT_MS + LIVENESS_RESUME_GRACE_MS
      try { ws.send(Uint8Array.of(STATUS_REPORT_BYTE)) } catch { /* noop */ }
      return
    }
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
    if (silentResponsesBeforeReset > 0) silentResponsesBeforeReset--
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

// Reports that arrive in a burst (a tab Chrome froze and then resumed) are
// merged and applied at most once per interval, so a backlog does not cost a
// full render per report. State changes (including a hold completing and the
// single-block pin) and local streams stay exact.
const STATUS_APPLY_INTERVAL_MS = 100
let pendingStatusReport: Partial<MachineStatus> | null = null
let statusApplyTimer: ReturnType<typeof setTimeout> | null = null
let lastStatusAppliedAt = 0

function flushStatusReport() {
  if (statusApplyTimer) { clearTimeout(statusApplyTimer); statusApplyTimer = null }
  const report = pendingStatusReport
  if (!report) return
  pendingStatusReport = null
  lastStatusAppliedAt = Date.now()
  const machine = useMachineStore.getState()
  machine.updateStatus(report)
  if (!machine.statusReceived) machine.setStatusReceived(true)
}

function applyStatusReport(report: Partial<MachineStatus>) {
  pendingStatusReport = pendingStatusReport ? { ...pendingStatusReport, ...report } : report
  const sinceLastApply = Date.now() - lastStatusAppliedAt
  const current = useMachineStore.getState().status
  if (
    responseTrafficSuspensions > 0
    || report.state !== current.state
    || report.holdComplete !== current.holdComplete
    || report.pinState !== current.pinState
    || sinceLastApply >= STATUS_APPLY_INTERVAL_MS
  ) {
    flushStatusReport()
  } else if (!statusApplyTimer) {
    statusApplyTimer = setTimeout(flushStatusReport, STATUS_APPLY_INTERVAL_MS - sinceLastApply)
  }
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

  const isSilentLine = consumeSilentLine(line)

  if (line.startsWith('<') && line.endsWith('>')) {
    const parsed = parseStatusReport(line, {
      reportInches: useMachineStore.getState().controllerSettings.reportInches,
    })
    statusReportsSincePoll++
    if (parsed) applyStatusReport(parsed)
    lineHandlers.forEach(fn => fn(line))
    return
  }

  // Keep status updates in arrival order behind a deferred report.
  flushStatusReport()

  const gcState = parseGcStateLine(line)
  if (gcState) {
    lastGcStateAt = Date.now()
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

  if (line === 'ok' || line === 'error') {
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
  // indistinguishable from a program-block acknowledgement.
  if (responseTrafficSuspensions > 0 || useMachineStore.getState().controllerResetPending) return false
  queueCommand({ command: cmd, isRealtime: false, priority: 'normal', timestamp: Date.now() })
  return socket?.readyState === WebSocket.OPEN
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
  // A query sent now would queue behind replies the reset may have dropped
  // (or be dropped itself), so it waits for the cooldown to end.
  if (useMachineStore.getState().controllerResetPending) {
    if (responseTrafficSuspensions > 0 || socket?.readyState !== WebSocket.OPEN) return false
    silentQueriesAfterReset.push({ command: cmd, isRealtime: false, priority: 'normal', timestamp: Date.now(), silentResponseMatcher })
    return true
  }
  if (responseTrafficSuspensions > 0) return false
  queueCommand({
    command: cmd,
    isRealtime: false,
    priority: 'normal',
    timestamp: Date.now(),
    silentResponseMatcher,
  })
  return socket?.readyState === WebSocket.OPEN
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
    && silentQueriesAfterReset.length === 0
    && pendingAcknowledgments.size === 0
    && pendingSilentResponses.length === 0
    && activeSilentResponse === null
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
  } catch {
    // FluidNC refuses HTTP commands while the machine moves, so a page opened
    // during a job asks over the websocket, where $$ is allowed in any state
    // ($Report/Inches is not). Status reports are scaled by $13.
    sendSilentRaw('$$', {
      starts: (line) => /^\$\d+=|^error/.test(line),
      consume: (line) => /^\$\d+=/.test(line),
      done: (line) => line === 'ok' || line.startsWith('error'),
    })
  }
  return canContinue()
}

export function sendRealtime(byte: number) {
  // Unlike other realtime inputs, Ctrl-X changes local safety state. Do not
  // queue it or show a reset cooldown unless it can actually be sent.
  if (byte === 0x18 && socket?.readyState !== WebSocket.OPEN) return false
  queueCommand({
    command: byte.toString(),
    isRealtime: true,
    priority: byte === 0x18 ? 'emergency' : 'normal',
    timestamp: Date.now(),
  })
  return socket?.readyState === WebSocket.OPEN
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
  flushStatusReport()
  generation++
  backgroundTrafficSuspensions = 0
  responseTrafficSuspensions = 0
  stopLivenessWatchdog()
  stopStatusPoll()
  stopGcStatePoll()
  stopCommandProcessor()
  pendingSilentResponses.length = 0
  activeSilentResponse = null
  settleExclusiveCommand('disconnected')
  pendingAcknowledgments.forEach(({ timeoutId }) => clearTimeout(timeoutId))
  pendingAcknowledgments.clear()
  commandQueue.length = 0
  silentQueriesAfterReset.length = 0
  silentResponsesBeforeReset = 0
  closeCurrentSocket()
  if (useMachineStore.getState().connected) {
    useMachineStore.getState().setConnected(false)
  }
}
