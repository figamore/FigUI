import { create } from 'zustand'
import { useMachineStore } from '../store'
import { isSocketOpen, onLine, onSessionTaken, onSoftReset, sendRealtimeNow } from '../lib/ws'
import { sendBlockMode } from '../lib/http'
import { useGCodeSenderStore } from './gcodeSender'
import { parseStepReport, supportsSingleBlock, type PendingBlock } from '../lib/singleBlock'

interface SingleBlockState {
  requestedMode: boolean | null
  pendingBlock: PendingBlock | null
  displayedBlock: PendingBlock | null
  ready: boolean
  advancing: boolean
  error: string | null
  setMode: (enabled: boolean) => void
  resume: () => void
  clearError: () => void
}

let confirmationTimer: ReturnType<typeof setTimeout> | null = null
let modeRequest: AbortController | null = null

function clearConfirmationTimer() {
  if (confirmationTimer) clearTimeout(confirmationTimer)
  confirmationTimer = null
  modeRequest?.abort()
  modeRequest = null
}

function confirmMode(enabled: boolean) {
  const machine = useMachineStore.getState()
  const pins = machine.status.pinState.replace(/Q/g, '')
  machine.updateStatus({ pinState: enabled ? `${pins}Q` : pins })
  if (useSingleBlockStore.getState().requestedMode === enabled) {
    clearConfirmationTimer()
    useSingleBlockStore.setState({ requestedMode: null, error: null })
  }
}

function clearSession() {
  clearConfirmationTimer()
  useSingleBlockStore.setState({ requestedMode: null, pendingBlock: null, displayedBlock: null, ready: false, advancing: false, error: null })
}

export const useSingleBlockStore = create<SingleBlockState>((set, get) => ({
  requestedMode: null,
  pendingBlock: null,
  displayedBlock: null,
  ready: false,
  advancing: false,
  error: null,
  setMode: enabled => {
    const machine = useMachineStore.getState()
    const streaming = ['streaming', 'paused', 'draining'].includes(useGCodeSenderStore.getState().phase)
    if (get().requestedMode !== null || !machine.connected || machine.controllerResetPending
      || streaming || !supportsSingleBlock(machine.espInfo?.version) || !isSocketOpen()) return
    // A file can keep its initiating WebSocket waiting for the job's final ack.
    // HTTP executes this ReportCommand independently, including during Hold.
    const request = new AbortController()
    modeRequest = request
    set({ requestedMode: enabled, error: null })
    confirmationTimer = setTimeout(() => {
      clearConfirmationTimer()
      set({ requestedMode: null, error: 'Mode change timed out.' })
    }, 4000)
    void sendBlockMode(enabled, request.signal).then(response => {
      if (modeRequest !== request) return
      const failure = response.match(/(?:^|\n)error(?::(\d+))?\s*(?:\n|$)/i)
      if (failure) {
        clearConfirmationTimer()
        set({ requestedMode: null, error: failure[1] ? `Mode change failed (error ${failure[1]}).` : 'Mode change failed.' })
      } else if (/(?:^|\n)ok\s*(?:\n|$)/i.test(response)
        || response.includes(`Single Block Mode ${enabled ? 'Enabled' : 'Disabled'}`)) {
        // An already-applied $GB returns only ok; its HTTP reply belongs to this
        // request, so it cannot be confused with another command's acknowledgment.
        confirmMode(enabled)
      }
    }).catch(() => {
      if (modeRequest !== request) return
      clearConfirmationTimer()
      set({ requestedMode: null, error: 'Mode change failed.' })
    })
  },
  resume: () => {
    const { status, connected, controllerResetPending } = useMachineStore.getState()
    const state = get()
    if (!connected || controllerResetPending || state.requestedMode !== null || state.advancing) return
    if (status.state !== 'Hold' && status.state !== 'Door') return
    if (status.state === 'Hold' && status.holdComplete === false) return
    if (status.state === 'Hold' && state.pendingBlock && !state.ready) return
    if (!sendRealtimeNow(0x7e)) return
    // One click releases one line. Modal-only lines stay locked until another
    // Step reaches Hold:0, since they may never emit an intervening Run report.
    set({ pendingBlock: null, ready: false, advancing: status.pinState.includes('Q'), error: null })
  },
  clearError: () => set({ error: null }),
}))

onLine(line => {
  if (line.startsWith('Grbl ')) {
    clearSession()
    useMachineStore.getState().updateStatus({ pinState: '', holdComplete: undefined })
    return
  }
  const modeReport = line.match(/^\[MSG:INFO:\s*Single Block Mode (Enabled|Disabled)\]$/i)
  if (modeReport) {
    confirmMode(modeReport[1].toLowerCase() === 'enabled')
    return
  }
  const block = parseStepReport(line)
  if (block) {
    useSingleBlockStore.setState({ pendingBlock: block, displayedBlock: block, ready: false })
    return
  }
  if (!line.startsWith('<') || !line.endsWith('>')) return
  const { status } = useMachineStore.getState()
  const state = useSingleBlockStore.getState()
  if (state.requestedMode !== null && status.pinState.includes('Q') === state.requestedMode) {
    clearConfirmationTimer()
    useSingleBlockStore.setState({ requestedMode: null, error: null })
  }
  if (status.state === 'Hold' && status.holdComplete && state.pendingBlock) {
    useSingleBlockStore.setState({ ready: true, advancing: false })
  } else if (status.state === 'Alarm' || status.state === 'Check' || status.state === 'Sleep'
    || (status.state === 'Idle' && (!state.pendingBlock || state.ready))
    || (status.state === 'Run' && state.ready)) {
    useSingleBlockStore.setState({ pendingBlock: null, displayedBlock: null, ready: false, advancing: false })
  } else if (!status.pinState.includes('Q') && !state.pendingBlock) {
    useSingleBlockStore.setState({ advancing: false })
  } else if ((status.state === 'Run' || status.state === 'Door') && !state.pendingBlock) {
    // A manual feed hold or safety door can interrupt the line after motion starts.
    // Those are ordinary resumable stops, even before the next Step report.
    useSingleBlockStore.setState({ advancing: false })
  }
})

onSoftReset(() => {
  clearSession()
  useMachineStore.getState().updateStatus({ pinState: '', holdComplete: undefined })
})
onSessionTaken(clearSession)
useMachineStore.subscribe((state, previous) => {
  if (previous.connected && !state.connected) clearSession()
  // M0 can hold again without a Run transition or a new Step. Modal reports
  // also arrive through the silent $G poll, which does not notify onLine handlers.
  if (state.status.gcodeModes !== previous.status.gcodeModes
    && state.status.gcodeModes?.programState === 'M0'
    && state.status.state === 'Hold'
    && !useSingleBlockStore.getState().pendingBlock) {
    useSingleBlockStore.setState({ advancing: false })
  }
})
