import { onSoftReset, sendRaw, sendSilentRaw } from './ws'
import { useMachineStore } from '../store'

// Probe moves run in G91. A cycle that ends on an alarm, error, timeout or
// disconnect leaves the controller there, and a probe-fail alarm cleared with
// $X keeps it there. G90 is sent once the controller is Idle again, even when
// the probe panel was closed in the meantime, so a later MDI or macro move is
// not taken as relative. A queued line is lost if the connection drops while
// it is sent, so G90 is followed by its own $G and this ends only when that
// reply shows G90. The reply comes before any line sent after it, so a G91
// the operator types later is never taken for a lost G90.
let cycleActive = false
let release: (() => void) | null = null
// The G90 whose $G reply is awaited (0: none). Each send has its own number,
// so a reply to an earlier one is not taken for it.
let sends = 0
let awaited = 0

const isModalReport = (line: string) => line.startsWith('[GC:') && line.endsWith(']')

function sendAbsolute() {
  const send = ++sends
  // Set first so a store update from inside sendRaw cannot send it twice.
  awaited = send
  if (!sendRaw('G90')) {
    awaited = 0
    return
  }
  const asked = sendSilentRaw('$G', {
    starts: isModalReport,
    consume: (line) => {
      if (!isModalReport(line)) return false
      if (awaited === send) {
        awaited = 0
        if (line.slice(4, -1).split(' ').includes('G90')) clearProbeRelative()
        else restoreWhenIdle()
      }
      return true
    },
    done: (line) => line === 'ok' || line === 'error' || line.startsWith('error:'),
  })
  // Nothing could confirm it then; take the G90 as sent.
  if (!asked) clearProbeRelative()
}

function restoreWhenIdle() {
  if (!release) return
  const { connected, status } = useMachineStore.getState()
  if (awaited) {
    if (connected) return
    // After a drop it is not known whether G90 arrived; send it again.
    awaited = 0
  }
  if (cycleActive || !connected || status.state !== 'Idle') return
  sendAbsolute()
}

/** Call after sending a relative probe move. */
export function markProbeRelative() {
  // A reply still on its way describes the state before this move.
  awaited = 0
  if (release) return
  const stopStore = useMachineStore.subscribe(restoreWhenIdle)
  // A soft reset already puts the controller back in G90.
  const stopReset = onSoftReset(clearProbeRelative)
  release = () => { stopStore(); stopReset() }
}

/** Sends G90 at the end of a probe cycle, and again until its $G shows it took. */
export function restoreProbeAbsolute() {
  markProbeRelative()
  sendAbsolute()
}

/** Stops watching, as after a soft reset. */
export function clearProbeRelative() {
  release?.()
  release = null
  awaited = 0
}

/** G90 waits while a probe cycle is still running. */
export function setProbeCycleActive(active: boolean) {
  cycleActive = active
  if (!active) restoreWhenIdle()
}
