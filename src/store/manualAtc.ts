import { create } from 'zustand'
import { useMachineStore } from '../store'
import { onLine, onSoftReset, sendRaw, sendRealtime } from '../lib/ws'
import { useGCodeSenderStore } from './gcodeSender'
import { isDoorBlocked } from '../lib/door'

export type ManualAtcPhase = 'idle' | 'moving' | 'awaiting-tool' | 'resuming'

interface ManualAtcState {
  phase: ManualAtcPhase
  requestedTool: number | null
  resetReference: () => boolean
  completeReferenceSetup: () => boolean
  requestToolChange: () => boolean
  resumeToolChange: () => boolean
}

let syntheticTool = 0
let pauseSeen = false

function machineReady() {
  const machine = useMachineStore.getState()
  return machine.connected
    && machine.status.state === 'Idle'
    && machine.controllerSettings.hasManualATC === true
}

export const useManualAtcStore = create<ManualAtcState>((set) => ({
  phase: 'idle',
  requestedTool: null,

  resetReference: () => {
    if (!machineReady() || !sendRaw('M61 Q0')) return false
    syntheticTool = 0
    pauseSeen = false
    set({ phase: 'idle', requestedTool: null })
    return true
  },

  completeReferenceSetup: () => {
    if (useMachineStore.getState().controllerSettings.hasManualATC !== true) return false
    if (!sendRaw('M61 Q1')) return false
    syntheticTool = 1
    return true
  },

  requestToolChange: () => {
    const machine = useMachineStore.getState()
    const plane = machine.status.gcodeModes?.plane
    if (!machineReady() || (plane != null && plane !== 'G17')) return false

    let current = syntheticTool || machine.status.gcodeModes?.tool || 0
    if (!current) {
      current = 1
      if (!sendRaw('M61 Q1')) return false
    }
    const next = current === 1 ? 2 : 1
    if (!sendRaw(`M6 T${next}`)) return false

    syntheticTool = next
    pauseSeen = false
    set({ phase: 'moving', requestedTool: next })
    return true
  },

  resumeToolChange: () => {
    const machine = useMachineStore.getState()
    const doorReady = machine.status.state === 'Door' && !isDoorBlocked(machine.status)
    if (machine.status.state !== 'Hold' && !doorReady) return false

    if (useGCodeSenderStore.getState().phase === 'paused') {
      useGCodeSenderStore.getState().resume()
    } else if (!sendRealtime(0x7e)) {
      return false
    }
    set({ phase: 'resuming' })
    return true
  },
}))

onLine(line => {
  if (useMachineStore.getState().controllerSettings.hasManualATC !== true) return
  const installPrompt = line.match(/\bInstall tool\s*#?(\d+)\b.*resume to continue/i)
  if (installPrompt) {
    pauseSeen = false
    useManualAtcStore.setState({
      phase: 'awaiting-tool',
      requestedTool: Number.parseInt(installPrompt[1], 10),
    })
  } else if (/\bInstall tool\b/i.test(line) || /^error:/i.test(line) || /^ALARM:/i.test(line)) {
    pauseSeen = false
    useManualAtcStore.setState({ phase: 'idle', requestedTool: null })
  }
})

onSoftReset(() => {
  syntheticTool = 0
  pauseSeen = false
  useManualAtcStore.setState({ phase: 'idle', requestedTool: null })
})

useMachineStore.subscribe((machine, previous) => {
  const reportedTool = machine.status.gcodeModes?.tool
  const previousTool = previous.status.gcodeModes?.tool
  if (reportedTool != null && reportedTool !== previousTool) syntheticTool = reportedTool

  const phase = useManualAtcStore.getState().phase
  if (!machine.connected || machine.status.state === 'Alarm') {
    pauseSeen = false
    if (phase !== 'idle') useManualAtcStore.setState({ phase: 'idle', requestedTool: null })
    return
  }

  if (phase === 'awaiting-tool' && (machine.status.state === 'Hold' || machine.status.state === 'Door')) {
    pauseSeen = true
  } else if ((phase === 'awaiting-tool' || phase === 'resuming') && pauseSeen
    && machine.status.state !== 'Hold' && machine.status.state !== 'Door') {
    pauseSeen = false
    useManualAtcStore.setState({ phase: 'idle', requestedTool: null })
  }
})
