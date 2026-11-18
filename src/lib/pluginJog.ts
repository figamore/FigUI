import { useMachineStore } from '../store'
import {
  isResponseTrafficQuiescent,
  isSocketOpen,
  onSessionTaken,
  onSoftReset,
  resumeResponseTraffic,
  sendExclusiveResponseCommand,
  sendRealtimeNow,
  trySuspendResponseTraffic,
} from './ws'

/** One plugin owns jog acknowledgements until it leaves live control. */
export function createPluginJogSender() {
  let ownsLane = false
  let generation = 0
  let pending: Promise<string> | null = null
  let closing: Promise<void> | null = null
  let disposed = false

  function checkReady(stamp: number) {
    const machine = useMachineStore.getState()
    if (stamp !== generation || disposed) throw new Error('Jog cancelled')
    if (!isSocketOpen() || !machine.connected) throw new Error('Not connected')
    if (machine.controllerResetPending) throw new Error('Controller is resetting')
    if (!['Idle', 'Jog'].includes(machine.status.state)) throw new Error(`Cannot jog while machine is ${machine.status.state}`)
  }

  function cancel() {
    generation++ // Also discard a destination waiting for earlier responses.
    return sendRealtimeNow(0x85)
  }

  function close(): Promise<void> {
    if (closing) return closing
    if (!ownsLane) return Promise.resolve()
    cancel()
    const inFlight = pending
    closing = (async () => {
      // Consume the outstanding jog's terminal response before allowing $G
      // or a program stream onto the same acknowledgement channel again.
      try { await inFlight } catch { /* The caller receives the jog error. */ }
      ownsLane = false
      resumeResponseTraffic()
    })().finally(() => { closing = null })
    return closing
  }

  async function send(command: string): Promise<string> {
    if (!/^\$J=[\x20-\x7e]+$/.test(command) || /[\r\n]/.test(command)) throw new Error('Expected one $J= jog command')
    if (pending || closing) throw new Error('Wait for the previous jog acknowledgement')
    const stamp = generation
    checkReady(stamp)
    const preparing = !ownsLane
    if (preparing) {
      if (!trySuspendResponseTraffic()) throw new Error('Controller command channel is busy')
      ownsLane = true
    }
    pending = (async () => {
      if (preparing) {
        const startedAt = Date.now()
        // Drain commands that predate this lease. Status polling remains live.
        while (!isResponseTrafficQuiescent()) {
          checkReady(stamp)
          if (Date.now() - startedAt > 2000) throw new Error('An earlier controller command did not finish')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      checkReady(stamp)
      const response = await sendExclusiveResponseCommand(command, 2000)
      if (response.outcome !== 'ok') {
        throw new Error(response.lines.find(line => /^(error|ALARM:)/.test(line))
          ?? `Jog acknowledgement ${response.outcome}`)
      }
      return response.lines.join('\n')
    })()
    try {
      return await pending
    } catch (error) {
      void close()
      throw error
    } finally {
      pending = null
    }
  }

  const stopReset = onSoftReset(() => { void close() })
  const stopTakeover = onSessionTaken(() => { void close() })
  const stopConnection = useMachineStore.subscribe((machine, previous) => {
    if (previous.connected && !machine.connected) void close()
  })

  return {
    send,
    cancel,
    close,
    dispose() {
      disposed = true
      stopReset()
      stopTakeover()
      stopConnection()
      void close()
    },
  }
}
