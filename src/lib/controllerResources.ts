import { useMachineStore } from '../store'
import type { MachineStatus } from '../types'

type ResourceState = {
  connected: boolean
  statusReceived: boolean
  status: Pick<MachineStatus, 'state' | 'sdFilename'>
}

export function canLoadControllerResources(machine: ResourceState): boolean {
  return machine.connected && machine.statusReceived && !machine.status.sdFilename
    && ['Idle', 'Alarm', 'Check', 'Sleep'].includes(machine.status.state)
}

export function useControllerResourcesReady(): boolean {
  return useMachineStore(canLoadControllerResources)
}

export function scheduleControllerStartup(
  load: (canContinue: () => boolean) => Promise<boolean>,
  onPending: (pending: boolean) => void,
): () => void {
  let stopped = false
  let inFlight = false
  let completed = false
  let interrupted = false

  const ready = () => canLoadControllerResources(useMachineStore.getState())
  const canContinue = () => !stopped && !interrupted && ready()
  const check = () => {
    if (stopped) return
    if (!ready()) {
      if (inFlight) interrupted = true
      return
    }
    if (inFlight || completed) return
    inFlight = true
    interrupted = false
    onPending(true)
    Promise.resolve()
      .then(() => canContinue() ? load(canContinue) : false)
      // A false result without an interruption is terminal too. Otherwise the
      // pending-state update below would immediately restart the same load.
      .then(() => { completed = canContinue() })
      // A failed load must not turn each status report into another HTTP retry.
      .catch(() => { completed = canContinue() })
      .finally(() => {
        inFlight = false
        if (stopped) return
        onPending(false)
        if (interrupted && ready()) check()
      })
  }

  const unsubscribe = useMachineStore.subscribe(check)
  check()
  return () => {
    stopped = true
    unsubscribe()
    onPending(false)
  }
}
