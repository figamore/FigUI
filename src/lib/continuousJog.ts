import { getConnectionHealth, isSocketOpen, sendRaw } from './ws'
import { getWatchdogState, setLocalJogActive } from './jogWatchdog'

/** Each continuous jog segment covers the time since the previous one. */
export const CONTINUOUS_SEGMENT_MS = 100
/** Motion queued ahead of the machine: how far a jog runs on if its stop is lost. */
export const CONTINUOUS_LEAD_MS = 300
/**
 * Every segment is answered with `ok`, so a controller this quiet means the
 * link has stalled. Segments sent into a stalled socket would all arrive and
 * run at once when it recovers.
 */
export const CONTINUOUS_SILENCE_MS = 1000

const activeStreams = new Set<() => void>()

function linkUp() {
  return isSocketOpen() && Date.now() - getConnectionHealth().lastResponseTime <= CONTINUOUS_SILENCE_MS
}

/**
 * Run a continuous jog as a stream of short $J segments instead of one long
 * move. FluidNC queues them, so motion stays smooth, but if the stop never
 * arrives (WiFi drop, frozen or closed page) the machine runs out of segments
 * within a fraction of a second instead of running until it hits the frame.
 * `dirs` holds entries like 'X+'; `feed` is the vector feed in mm/min.
 * Returns a function that stops sending; the caller still sends the jog cancel.
 */
export function startContinuousJog(dirs: string[], feed: number): () => void {
  // One stream at a time: two held controls would each queue the full
  // elapsed time, and the machine runs their segments one after the other.
  stopContinuousJogs()
  if (dirs.length === 0 || !linkUp()) return () => {}
  const mmPerMs = feed / 60000 / Math.sqrt(dirs.length)
  const send = (ms: number) => {
    const dist = mmPerMs * ms
    const words = dirs.map(d => `${d[0]}${(d[1] === '+' ? dist : -dist).toFixed(3)}`).join(' ')
    setLocalJogActive(true)
    sendRaw(`$J=G91 G21 F${feed} ${words}`)
  }

  let last = Date.now()
  send(CONTINUOUS_LEAD_MS)
  const timer = setInterval(() => {
    // The jog watchdog cancels a jog it sees without held input; stop here
    // too, or the next segment would restart the motion it just cancelled.
    if (!linkUp() || getWatchdogState().escalationStartTime > 0) { stop(); return }
    const now = Date.now()
    const elapsed = Math.min(now - last, CONTINUOUS_LEAD_MS)
    last = now
    if (elapsed > 0) send(elapsed)
  }, CONTINUOUS_SEGMENT_MS)
  const stop = () => {
    clearInterval(timer)
    activeStreams.delete(stop)
  }
  activeStreams.add(stop)
  return stop
}

/** Stop every segment stream, so a jog stop button holds even while a jog control is still pressed. */
export function stopContinuousJogs() {
  for (const stop of [...activeStreams]) stop()
}
