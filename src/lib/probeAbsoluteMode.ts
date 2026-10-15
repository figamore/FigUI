import { onSoftReset, sendRaw } from './ws'
import { useMachineStore } from '../store'

// Probe moves run in G91. A cycle that ends on an alarm, error, timeout or
// disconnect leaves the controller there, and a probe-fail alarm cleared with
// $X keeps it there. G90 is sent once the controller is Idle again, even when
// the probe panel was closed in the meantime, so a later MDI or macro move is
// not taken as relative.
let cycleActive = false
let release: (() => void) | null = null

function restoreWhenIdle() {
  if (!release || cycleActive) return
  const { connected, status } = useMachineStore.getState()
  if (!connected || status.state !== 'Idle') return
  // Cleared first so a store update from inside sendRaw cannot send it twice.
  const stop = release
  release = null
  if (sendRaw('G90')) stop()
  else release = stop
}

/** Call after sending a relative probe move. */
export function markProbeRelative() {
  if (release) return
  const stopStore = useMachineStore.subscribe(restoreWhenIdle)
  // A soft reset already puts the controller back in G90.
  const stopReset = onSoftReset(clearProbeRelative)
  release = () => { stopStore(); stopReset() }
}

/** Call once G90 has been sent. */
export function clearProbeRelative() {
  release?.()
  release = null
}

/** G90 waits while a probe cycle is still running. */
export function setProbeCycleActive(active: boolean) {
  cycleActive = active
  if (!active) restoreWhenIdle()
}
