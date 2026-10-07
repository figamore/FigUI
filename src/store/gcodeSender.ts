import { create } from 'zustand'
import { useMachineStore } from '../store'
import { useGCodeStore } from './gcode'
import {
  getLastDisconnectReason,
  isResponseTrafficQuiescent,
  isSocketOpen,
  isStreamTransportWritable,
  onLine,
  onSessionTaken,
  onSoftReset,
  resumeResponseTraffic,
  sendExclusiveResponseCommand,
  sendRealtimeNow,
  sendStreamRaw,
  suspendResponseTraffic,
} from '../lib/ws'

export type SenderPhase = 'idle' | 'streaming' | 'paused' | 'draining' | 'completed' | 'aborted' | 'error'

type StreamBarrier = 'pause' | 'tool-change' | 'end' | null

interface StreamBlock {
  command: string
  sourceLine: number
  wireBytes: number
  barrier: StreamBarrier
  hasMotion: boolean
}

interface SenderState {
  phase: SenderPhase
  fileName: string | null
  showRuntimeEstimate: boolean
  jobId: number
  acceptedLine: number | null
  failureLine: number | null
  failureLineSource: 'position' | 'acknowledged' | null
  totalSourceLines: number
  completedBlocks: number
  totalBlocks: number
  notice: string | null
  error: string | null
  start: (text: string, fileName: string, options?: { showRuntimeEstimate?: boolean }) => boolean
  pause: () => void
  resume: () => void
  abort: () => void
  dismiss: () => void
}

const STREAM_WINDOW_BYTES = 127
//Bound response count as well as byte count so a burst of tiny commands cannot fill it with `ok`s.
const STREAM_WINDOW_BLOCKS = 8
const MAX_COMMAND_BYTES = 240
const TOOL_CHANGE_SETTLE_MS = 300
const DRAIN_IDLE_GRACE_MS = 1500
const PROGRESS_PUBLISH_MS = 100
const STREAM_PREPARE_TIMEOUT_MS = 5000
const TRANSPORT_RETRY_MS = 10
const LOST_ACK_IDLE_GRACE_MS = 3000

interface PendingBlock {
  block: StreamBlock
}

let blocks: StreamBlock[] = []
let pendingBlocks: PendingBlock[] = []
let nextBlock = 0
let inFlightBytes = 0
let ownsExclusiveTraffic = false
let completionTimer: ReturnType<typeof setTimeout> | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
let resumeTimer: ReturnType<typeof setTimeout> | null = null
let progressTimer: ReturnType<typeof setTimeout> | null = null
let pumpTimer: ReturnType<typeof setTimeout> | null = null
let acknowledgmentTimer: ReturnType<typeof setTimeout> | null = null
let resumePending = false
let responseChannelReady = false
let pendingIdleSince = 0
let acknowledgedBlocks = 0
let lastAcknowledgedLine: number | null = null
let programHasMotion = false
let sawBusyState = false
let drainStartedAt = 0
let endWasSynchronized = false
let previousReportInterval: number | null = null
let autoReportChanged = false
let finishing = false
let wakeLock: { release: () => Promise<void> } | null = null

function stripComments(raw: string) {
  // Most lines of large generated files carry no comment at all.
  if (raw.indexOf('(') < 0 && raw.indexOf(';') < 0) return raw.trim()
  let result = ''
  let depth = 0
  for (const char of raw) {
    if (char === ';' && depth === 0) break
    if (char === '(') { depth++; continue }
    if (char === ')' && depth > 0) { depth--; continue }
    if (depth === 0) result += char
  }
  return result.trim()
}

function classifyBlock(executable: string): { barrier: StreamBarrier; hasMotion: boolean } {
  const codes = new Set<number>()
  if (/m/i.test(executable)) {
    const mWords = executable.matchAll(/M\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi)
    for (const match of mWords) codes.add(Number(match[1]))
  }
  const barrier: StreamBarrier = codes.has(2) || codes.has(30)
    ? 'end'
    : codes.has(0)
      ? 'pause'
      : codes.has(6) ? 'tool-change' : null

  // Axis-only modal moves are motion too. A false positive only adds a short,
  // safe Idle confirmation at EOF; a false negative could complete too early.
  const hasMotion = /G\s*0*[0123](?:\.0*)?(?=[A-Z\s]|$)/i.test(executable)
    || /[XYZABC]\s*[+-]?(?:\d|\.)/i.test(executable)
  return { barrier, hasMotion }
}

/** UTF-8 byte length, without allocating an encoded copy of every line. */
function utf8ByteLength(text: string) {
  let bytes = text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) continue
    if (code < 0x800) {
      bytes += 1
      continue
    }
    bytes += 2
    // A surrogate pair is two UTF-16 units and four UTF-8 bytes; a lone
    // surrogate is encoded as the three-byte replacement character.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index++
    }
  }
  return bytes
}

export function buildStreamBlocks(text: string): {
  blocks: StreamBlock[]
  totalSourceLines: number
  ignoredAfterEnd: number
} {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const streamBlocks: StreamBlock[] = []
  let endSeen = false
  let ignoredAfterEnd = 0

  lines.forEach((raw, index) => {
    const executable = stripComments(raw)
    if (!executable || executable === '%') return
    if (endSeen) {
      ignoredAfterEnd++
      return
    }
    const command = raw.trim()
    const { barrier, hasMotion } = classifyBlock(executable)
    streamBlocks.push({
      command,
      sourceLine: index + 1,
      wireBytes: utf8ByteLength(command) + 1,
      barrier,
      hasMotion,
    })
    if (barrier === 'end') endSeen = true
  })
  return { blocks: streamBlocks, totalSourceLines: Math.max(1, lines.length), ignoredAfterEnd }
}

function clearTimers() {
  if (completionTimer) clearTimeout(completionTimer)
  if (settleTimer) clearTimeout(settleTimer)
  if (resumeTimer) clearTimeout(resumeTimer)
  if (progressTimer) clearTimeout(progressTimer)
  if (pumpTimer) clearTimeout(pumpTimer)
  if (acknowledgmentTimer) clearTimeout(acknowledgmentTimer)
  completionTimer = null
  settleTimer = null
  resumeTimer = null
  progressTimer = null
  pumpTimer = null
  acknowledgmentTimer = null
}

function publishProgress() {
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = null
  useGCodeSenderStore.setState({
    completedBlocks: acknowledgedBlocks,
    acceptedLine: lastAcknowledgedLine,
  })
}

function recordAcknowledgment(block: StreamBlock, publishImmediately = false) {
  acknowledgedBlocks++
  lastAcknowledgedLine = block.sourceLine
  if (publishImmediately) {
    publishProgress()
  } else if (!progressTimer) {
    progressTimer = setTimeout(publishProgress, PROGRESS_PUBLISH_MS)
  }
}

async function acquireWakeLock() {
  if (wakeLock || document.visibilityState !== 'visible') return
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
  }
  try { wakeLock = await nav.wakeLock?.request('screen') ?? null } catch { /* unsupported or denied */ }
}

function releaseWakeLock() {
  const current = wakeLock
  wakeLock = null
  if (current) void current.release().catch(() => undefined)
}

function releaseExclusiveTraffic() {
  if (!ownsExclusiveTraffic) return
  ownsExclusiveTraffic = false
  resumeResponseTraffic()
}

function disconnectedMessage(action = 'streaming') {
  const reason = getLastDisconnectReason()
  return `Controller disconnected while ${action}${reason ? `: ${reason}` : ''}.`
}

interface FinishRequest {
  phase: 'completed' | 'aborted' | 'error'
  error: string | null
  failureLine: number | null
  failureLineSource: 'position' | 'acknowledged' | null
}

function finalizeFinish(request: FinishRequest) {
  previousReportInterval = null
  autoReportChanged = false
  releaseExclusiveTraffic()
  releaseWakeLock()
  finishing = false
  useGCodeSenderStore.setState(request)
}

function finish(phase: 'completed' | 'aborted' | 'error', error: string | null = null) {
  if (finishing) return
  finishing = true
  const trackedLine = phase === 'error' ? useGCodeStore.getState().activeSourceLine : null
  const failureLine = phase === 'error' ? trackedLine ?? lastAcknowledgedLine : null
  const request: FinishRequest = {
    phase,
    error,
    failureLine,
    failureLineSource: trackedLine != null
      ? 'position'
      : failureLine != null ? 'acknowledged' : null,
  }
  publishProgress()
  clearTimers()
  pendingBlocks = []
  inFlightBytes = 0
  resumePending = false
  responseChannelReady = false
  pendingIdleSince = 0

  if (!autoReportChanged || previousReportInterval == null || !isSocketOpen()) {
    finalizeFinish(request)
    return
  }

  // After reset/error, allow stale program responses to drain before issuing
  // the restoration command. Normal completion already has an empty FIFO.
  const restoreDelay = phase === 'completed' ? 0 : 500
  settleTimer = setTimeout(() => {
    settleTimer = null
    void sendExclusiveResponseCommand(`$RI=${previousReportInterval}`, 2000)
      .finally(() => finalizeFinish(request))
  }, restoreDelay)
}

function enterDraining(synchronizedEnd = false) {
  if (useGCodeSenderStore.getState().phase === 'draining') return
  drainStartedAt = Date.now()
  endWasSynchronized = synchronizedEnd
  useGCodeSenderStore.setState({ phase: 'draining' })
  scheduleDrainCheck()
}

function scheduleDrainCheck() {
  if (completionTimer) clearTimeout(completionTimer)
  completionTimer = setTimeout(() => {
    const sender = useGCodeSenderStore.getState()
    if (sender.phase !== 'draining') return
    const machineState = useMachineStore.getState().status.state
    const elapsed = Date.now() - drainStartedAt
    if (machineState === 'Idle' && (
      sawBusyState
      || endWasSynchronized
      || !programHasMotion
      || elapsed >= DRAIN_IDLE_GRACE_MS
    )) {
      finish('completed')
      return
    }
    scheduleDrainCheck()
  }, 200)
}

function schedulePump(delay = TRANSPORT_RETRY_MS) {
  if (pumpTimer) return
  pumpTimer = setTimeout(() => {
    pumpTimer = null
    pump()
  }, delay)
}

function scheduleAcknowledgmentCheck() {
  if (acknowledgmentTimer) clearTimeout(acknowledgmentTimer)
  acknowledgmentTimer = null
  if (pendingBlocks.length === 0) return
  acknowledgmentTimer = setTimeout(() => {
    acknowledgmentTimer = null
    const sender = useGCodeSenderStore.getState()
    if (!ownsExclusiveTraffic || !['streaming', 'paused', 'draining'].includes(sender.phase)) return
    if (!isSocketOpen()) {
      finish('error', disconnectedMessage())
      return
    }

    // A Run/Hold/Door block can legitimately wait a long time for planner
    // space. Idle with an outstanding block cannot: the controller has
    // finished everything it accepted, so its terminal response was lost.
    const machineState = useMachineStore.getState().status.state
    if (machineState !== 'Idle') {
      pendingIdleSince = 0
    } else if (pendingIdleSince === 0) {
      pendingIdleSince = Date.now()
    } else if (Date.now() - pendingIdleSince >= LOST_ACK_IDLE_GRACE_MS) {
      const oldest = pendingBlocks[0]
      finish('error', `File line ${oldest.block.sourceLine}: controller stopped acknowledging the stream while the WebSocket remained open.`)
      return
    }
    scheduleAcknowledgmentCheck()
  }, 500)
}

async function configureStreamAutoReporting() {
  const query = await sendExclusiveResponseCommand('$RI')
  if (!ownsExclusiveTraffic || finishing || useGCodeSenderStore.getState().phase !== 'streaming') return

  if (query.outcome !== 'ok' && query.outcome !== 'error') {
    finish('error', 'Could not establish exclusive controller reporting for the G-code stream.')
    return
  }

  if (query.outcome === 'ok') {
    const joined = query.lines.join('\n')
    const intervalMatch = joined.match(/auto report interval is\s+(\d+)\s*ms/i)
    const wasOff = /auto reporting is off/i.test(joined)
    previousReportInterval = intervalMatch ? Number(intervalMatch[1]) : wasOff ? 0 : null

    if (previousReportInterval != null && previousReportInterval > 0) {
      // Once sent, a missing response is ambiguous: FluidNC may have applied
      // the change. Mark it for restoration until an explicit error proves it
      // was rejected.
      autoReportChanged = true
      const disabled = await sendExclusiveResponseCommand('$RI=0')
      if (!ownsExclusiveTraffic || finishing || useGCodeSenderStore.getState().phase !== 'streaming') return
      if (disabled.outcome === 'error') {
        autoReportChanged = false
      } else if (disabled.outcome !== 'ok') {
        finish('error', 'Controller stopped responding while automatic status reports were being suspended.')
        return
      }
    }
  }

  responseChannelReady = true
  pump()
}

function waitForExclusiveResponseChannel(startedAt: number) {
  if (!ownsExclusiveTraffic || useGCodeSenderStore.getState().phase !== 'streaming') return
  if (!isSocketOpen()) {
    finish('error', disconnectedMessage('preparing the stream'))
    return
  }
  if (isResponseTrafficQuiescent() && useMachineStore.getState().status.state === 'Idle') {
    void configureStreamAutoReporting()
    return
  }
  if (Date.now() - startedAt >= STREAM_PREPARE_TIMEOUT_MS) {
    finish('error', 'Could not start the stream because an earlier controller command did not finish.')
    return
  }
  settleTimer = setTimeout(() => {
    settleTimer = null
    waitForExclusiveResponseChannel(startedAt)
  }, 25)
}

function pump() {
  const state = useGCodeSenderStore.getState()
  if (state.phase !== 'streaming') return
  if (!responseChannelReady) return
  if (!isSocketOpen()) {
    finish('error', disconnectedMessage())
    return
  }
  if (!isStreamTransportWritable()) {
    schedulePump()
    return
  }

  while (nextBlock < blocks.length) {
    const block = blocks[nextBlock]
    const pendingBarrier = pendingBlocks.some(item => item.block.barrier !== null)
    if (pendingBarrier) return
    if (pendingBlocks.length >= STREAM_WINDOW_BLOCKS) return
    // Stop/tool/end commands must execute alone, after all earlier blocks have
    // acknowledged, so FluidNC cannot read past a program-control boundary.
    if (block.barrier && pendingBlocks.length > 0) return
    if (pendingBlocks.length > 0 && inFlightBytes + block.wireBytes > STREAM_WINDOW_BYTES) return

    if (!sendStreamRaw(block.command)) {
      finish('error', disconnectedMessage())
      return
    }
    pendingBlocks.push({ block })
    pendingIdleSince = 0
    inFlightBytes += block.wireBytes
    scheduleAcknowledgmentCheck()
    nextBlock++
    if (block.barrier) return
  }

  if (pendingBlocks.length === 0) enterDraining()
}

export const useGCodeSenderStore = create<SenderState>((set, get) => ({
  phase: 'idle',
  fileName: null,
  showRuntimeEstimate: true,
  jobId: 0,
  acceptedLine: null,
  failureLine: null,
  failureLineSource: null,
  totalSourceLines: 0,
  completedBlocks: 0,
  totalBlocks: 0,
  notice: null,
  error: null,

  start: (text, fileName, options) => {
    const machine = useMachineStore.getState()
    if (!isSocketOpen() || !machine.connected || machine.status.state !== 'Idle') return false
    if (['streaming', 'paused', 'draining'].includes(get().phase)) return false

    const built = buildStreamBlocks(text)
    if (built.blocks.length === 0) {
      set({ phase: 'error', fileName, notice: null, error: 'This file contains no executable G-code.' })
      return false
    }
    const oversized = built.blocks.find(block => block.wireBytes - 1 > MAX_COMMAND_BYTES)
    if (oversized) {
      set({
        phase: 'error',
        fileName,
        notice: null,
        error: `File line ${oversized.sourceLine} exceeds the supported ${MAX_COMMAND_BYTES}-byte controller line length.`,
      })
      return false
    }

    blocks = built.blocks
    pendingBlocks = []
    nextBlock = 0
    inFlightBytes = 0
    resumePending = false
    responseChannelReady = false
    pendingIdleSince = 0
    acknowledgedBlocks = 0
    lastAcknowledgedLine = null
    programHasMotion = blocks.some(block => block.hasMotion)
    sawBusyState = false
    drainStartedAt = 0
    endWasSynchronized = false
    previousReportInterval = null
    autoReportChanged = false
    finishing = false
    clearTimers()
    suspendResponseTraffic()
    ownsExclusiveTraffic = true
    set({
      phase: 'streaming',
      fileName,
      showRuntimeEstimate: options?.showRuntimeEstimate !== false,
      jobId: get().jobId + 1,
      acceptedLine: null,
      failureLine: null,
      failureLineSource: null,
      totalSourceLines: built.totalSourceLines,
      completedBlocks: 0,
      totalBlocks: built.blocks.length,
      notice: built.ignoredAfterEnd > 0
        ? `${built.ignoredAfterEnd} executable line${built.ignoredAfterEnd === 1 ? '' : 's'} after M2/M30 will not be sent.`
        : null,
      error: null,
    })
    void acquireWakeLock()
    // Stop new response-producing UI traffic, then wait until anything already
    // queued or on the wire has settled before claiming the FIFO response lane.
    const preparingSince = Date.now()
    settleTimer = setTimeout(() => {
      settleTimer = null
      waitForExclusiveResponseChannel(preparingSince)
    }, 25)
    return true
  },

  pause: () => {
    if (get().phase !== 'streaming' && get().phase !== 'draining') return
    // No program block has been sent while the response channel is preparing,
    // so entering Paused here would strand the preparation handshake.
    if (get().phase === 'streaming' && !responseChannelReady) return
    sendRealtimeNow(0x21)
    resumePending = false
    set({ phase: 'paused' })
  },

  resume: () => {
    if (get().phase !== 'paused') return
    if (useMachineStore.getState().status.state === 'Door') return
    if (!sendRealtimeNow(0x7e)) {
      finish('error', disconnectedMessage('resuming the stream'))
      return
    }
    resumePending = true
    // Wait for Run so post-M0 blocks cannot overtake cycle start. The fallback
    // covers an already-idle pause where FluidNC does not emit a Run report.
    resumeTimer = setTimeout(() => {
      if (!resumePending || useGCodeSenderStore.getState().phase !== 'paused') return
      const machineState = useMachineStore.getState().status.state
      if (machineState === 'Hold' || machineState === 'Door') {
        resumePending = false
        return
      }
      resumePending = false
      const phase = nextBlock >= blocks.length && pendingBlocks.length === 0 ? 'draining' : 'streaming'
      set({ phase })
      if (phase === 'streaming') pump()
      else { drainStartedAt = Date.now(); scheduleDrainCheck() }
    }, 500)
  },

  abort: () => {
    if (!['streaming', 'paused', 'draining'].includes(get().phase)) return
    sendRealtimeNow(0x18)
    finish('aborted')
  },

  dismiss: () => {
    if (['streaming', 'paused', 'draining'].includes(get().phase)) return
    set({ phase: 'idle', fileName: null, acceptedLine: null, failureLine: null, failureLineSource: null, notice: null, error: null })
  },
}))

onLine(line => {
  if (!ownsExclusiveTraffic || pendingBlocks.length === 0) return
  if (line === 'ok') {
    const acknowledged = pendingBlocks.shift()!.block
    pendingIdleSince = 0
    inFlightBytes = Math.max(0, inFlightBytes - acknowledged.wireBytes)
    scheduleAcknowledgmentCheck()
    recordAcknowledgment(acknowledged, acknowledged.barrier !== null || nextBlock >= blocks.length)

    if (acknowledged.barrier === 'pause') {
      resumePending = false
      useGCodeSenderStore.setState({ phase: 'paused' })
      return
    }
    if (acknowledged.barrier === 'end') {
      nextBlock = blocks.length
      enterDraining(true)
      return
    }
    if (acknowledged.barrier === 'tool-change') {
      settleTimer = setTimeout(() => {
        pump()
      }, TOOL_CHANGE_SETTLE_MS)
      return
    }
    pump()
  } else if (line === 'error' || line.startsWith('error:') || line.startsWith('ALARM:') || line.includes('[MSG:ERR')) {
    const sourceLine = pendingBlocks[0]?.block.sourceLine
    sendRealtimeNow(0x18)
    finish('error', `${sourceLine ? `File line ${sourceLine}: ` : ''}${line}`)
  }
})

onSoftReset(() => {
  if (ownsExclusiveTraffic) finish('aborted')
})

onSessionTaken(() => {
  if (!ownsExclusiveTraffic) return
  sendRealtimeNow(0x21)
  finish('error', 'Another FigUI page took control. The local stream was feed-held for safety.')
})

useMachineStore.subscribe((state, previous) => {
  const sender = useGCodeSenderStore.getState()
  if (!['streaming', 'paused', 'draining'].includes(sender.phase)) return
  if (previous.connected && !state.connected) {
    finish('error', disconnectedMessage())
    return
  }
  if (state.status.state === 'Alarm') {
    finish('error', `Controller alarm${state.status.alarmCode ? ` ${state.status.alarmCode}` : ''}.`)
    return
  }
  if (state.status.state !== 'Idle') sawBusyState = true
  if (
    responseChannelReady
    && (state.status.state === 'Hold' || state.status.state === 'Door')
    && sender.phase !== 'paused'
    && !resumePending
  ) {
    useGCodeSenderStore.setState({ phase: 'paused' })
  } else if (state.status.state === 'Run') {
    resumePending = false
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = null
    if (sender.phase === 'paused') {
      const phase = nextBlock >= blocks.length && pendingBlocks.length === 0 ? 'draining' : 'streaming'
      useGCodeSenderStore.setState({ phase })
      if (phase === 'streaming') pump()
      else { drainStartedAt = Date.now(); scheduleDrainCheck() }
    }
  }
})

window.addEventListener('beforeunload', event => {
  const phase = useGCodeSenderStore.getState().phase
  if (!['streaming', 'paused', 'draining'].includes(phase)) return
  event.preventDefault()
  event.returnValue = ''
})

window.addEventListener('pagehide', () => {
  const phase = useGCodeSenderStore.getState().phase
  if (['streaming', 'paused', 'draining'].includes(phase)) sendRealtimeNow(0x21)
})

document.addEventListener('visibilitychange', () => {
  const phase = useGCodeSenderStore.getState().phase
  if (document.visibilityState !== 'visible') {
    releaseWakeLock()
  } else if (['streaming', 'paused', 'draining'].includes(phase)) {
    void acquireWakeLock()
  }
})
