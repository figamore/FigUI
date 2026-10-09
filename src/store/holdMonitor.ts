import { create } from 'zustand'
import { useMachineStore } from '../store'
import { onLine, onSessionTaken, onSoftReset } from '../lib/ws'

interface HoldPause {
  id: number
  message: string | null
}

interface HoldMonitorState {
  current: HoldPause | null
  dismissed: boolean
  dismiss: () => void
  reopen: () => void
}

let nextId = 0
let pendingMessage: string | null = null

export const useHoldMonitorStore = create<HoldMonitorState>((set) => ({
  current: null,
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
  reopen: () => set({ dismissed: false }),
}))

function clearSession() {
  pendingMessage = null
  useHoldMonitorStore.setState({ current: null, dismissed: false })
}

// FluidNC wraps program comments as [MSG:INFO: MSG,text] or PRINT,text;
// older controllers can omit INFO or the comment prefix.
// Diagnostic messages (including Step reports) must not replace instructions.
export function parseHoldMessage(line: string): string | null {
  const match = line.match(/^\[MSG:(.*)\]$/i)
  if (!match) return null
  let text = match[1].trim()
  if (/^(?:INFO|ERR(?:OR)?|WARN(?:ING)?|DEBUG):/i.test(text)) {
    if (!/^INFO:\s*(?:(?:MSG|PRINT),|Install tool\b.*resume to continue)/i.test(text)) return null
    text = text.replace(/^INFO:\s*/i, '')
  }
  return text.replace(/^(?:MSG|PRINT),\s*/i, '').trim() || null
}

onLine(line => {
  if (line.startsWith('Grbl ')) { clearSession(); return }
  if (line.startsWith('<') && line.endsWith('>')) {
    const machine = useMachineStore.getState()
    const { current } = useHoldMonitorStore.getState()
    if (machine.connected && !machine.controllerResetPending && machine.status.state === 'Hold' && !current) {
      const pause: HoldPause = { id: nextId++, message: pendingMessage }
      pendingMessage = null
      useHoldMonitorStore.setState({ current: pause, dismissed: false })
    }
    return
  }
  const message = parseHoldMessage(line)
  if (message === null) return
  pendingMessage = message
  const { current } = useHoldMonitorStore.getState()
  // Some controllers deliver the comment after the first Hold status report.
  if (current) useHoldMonitorStore.setState({ current: { ...current, message } })
})

onSoftReset(clearSession)
onSessionTaken(clearSession)

useMachineStore.subscribe((machine, previous) => {
  const state = machine.status.state
  if (!machine.connected || machine.controllerResetPending || state === 'Alarm' || state === 'Unknown' || state === 'Sleep') {
    if (pendingMessage !== null || useHoldMonitorStore.getState().current || (previous.connected && !machine.connected)) clearSession()
    return
  }
  const { current } = useHoldMonitorStore.getState()
  if (current && state !== 'Hold' && state !== 'Door') {
    pendingMessage = null
    useHoldMonitorStore.setState({ current: null, dismissed: false })
  } else if (state === 'Idle' && previous.status.state !== 'Idle') {
    pendingMessage = null
  }
})
