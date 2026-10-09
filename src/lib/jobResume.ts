import { useMachineStore } from '../store'
import { useSingleBlockStore } from '../store/singleBlock'
import { useGCodeSenderStore } from '../store/gcodeSender'

export function useJobResume() {
  const status = useMachineStore(s => s.status)
  const connected = useMachineStore(s => s.connected)
  const resetPending = useMachineStore(s => s.controllerResetPending)
  const block = useSingleBlockStore()
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderActive = ['streaming', 'paused', 'draining'].includes(senderPhase)
  const stepHold = status.state === 'Hold' && status.pinState.includes('Q') && (!!block.pendingBlock || block.advancing) && !senderActive
  const disabled = !connected || resetPending || status.holdComplete === false
    || (status.state !== 'Hold' && status.state !== 'Door')
    || (senderActive ? status.state === 'Door' || senderPhase !== 'paused'
      : block.requestedMode !== null || block.advancing || (status.state === 'Hold' && !!block.pendingBlock && !block.ready))

  return { disabled, stepHold, resume: resumeHeldJob }
}

export function resumeHeldJob(): boolean {
  const { status, connected, controllerResetPending } = useMachineStore.getState()
  if (!connected || controllerResetPending || status.holdComplete === false
    || (status.state !== 'Hold' && status.state !== 'Door')) return false
  const sender = useGCodeSenderStore.getState()
  if (['streaming', 'paused', 'draining'].includes(sender.phase)) {
    if (sender.phase !== 'paused' || status.state === 'Door') return false
    sender.resume()
  } else {
    const block = useSingleBlockStore.getState()
    if (block.requestedMode !== null || block.advancing || (status.state === 'Hold' && block.pendingBlock && !block.ready)) return false
    block.resume()
  }
  return true
}
