import { onSoftReset, sendRaw } from './ws'
import { useMachineStore } from '../store'
import type { GCodeModes } from '../types'

// Probe moves run in G91. A cycle that ends on an alarm, error, timeout or
// disconnect leaves the controller there, and a probe-fail alarm cleared with
// $X keeps it there. G90 is sent once the controller is Idle again, even when
// the probe panel was closed in the meantime, so a later MDI or macro move is
// not taken as relative. A queued line is lost if the connection drops while
// it is sent, so this ends only once a [GC:] report shows G90.
let cycleActive = false
let release: (() => void) | null = null
// The modal state reported when G90 was last sent (null: not sent). A newer
// report tells whether it took.
let sentWith: GCodeModes | undefined | null = null

function sendAbsolute() {
  // Set first so a store update from inside sendRaw cannot send it twice.
  sentWith = useMachineStore.getState().status.gcodeModes
  if (!sendRaw('G90')) sentWith = null
}

function restoreWhenIdle() {
  if (!release) return
  const { connected, status } = useMachineStore.getState()
  if (sentWith !== null) {
    // After a drop it is not known whether G90 arrived; send it again.
    if (!connected) sentWith = null
    if (!connected || status.gcodeModes === sentWith) return
    if (status.gcodeModes?.distance === 'G90') {
      clearProbeRelative()
      return
    }
    sentWith = null
  }
  if (cycleActive || !connected || status.state !== 'Idle') return
  sendAbsolute()
}

/** Call after sending a relative probe move. */
export function markProbeRelative() {
  sentWith = null
  if (release) return
  const stopStore = useMachineStore.subscribe(restoreWhenIdle)
  // A soft reset already puts the controller back in G90.
  const stopReset = onSoftReset(clearProbeRelative)
  release = () => { stopStore(); stopReset() }
}

/** Sends G90 at the end of a probe cycle, and again until a report shows it took. */
export function restoreProbeAbsolute() {
  markProbeRelative()
  sendAbsolute()
}

/** Stops watching, as after a soft reset. */
export function clearProbeRelative() {
  release?.()
  release = null
  sentWith = null
}

/** G90 waits while a probe cycle is still running. */
export function setProbeCycleActive(active: boolean) {
  cycleActive = active
  if (!active) restoreWhenIdle()
}
