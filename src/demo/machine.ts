// Port of fluidnc-web-sim.py standalone machine state and command handlers

interface MachineState {
  state: string
  wpos: number[]
  mpos: number[]
  feed: number
  spindle: number
  feedOv: number
  rapidOv: number
  spindleOv: number
  sdFile: string | null
  sdPct: number
}

const m: MachineState = {
  state: 'Idle',
  wpos: [0, 0, 0],
  mpos: [0, 0, 0],
  feed: 0,
  spindle: 0,
  feedOv: 100,
  rapidOv: 100,
  spindleOv: 100,
  sdFile: null,
  sdPct: 0,
}

const AXIS: Record<string, number> = { X: 0, Y: 1, Z: 2, A: 3, B: 4, C: 5 }

export function statusReport(): string {
  const { state, wpos, mpos, feed, spindle, feedOv, rapidOv, spindleOv, sdFile, sdPct } = m
  const w = wpos.map(v => v.toFixed(3)).join(',')
  const p = mpos.map(v => v.toFixed(3)).join(',')
  let s = `<${state}|WPos:${w}|MPos:${p}|FS:${feed},${spindle}|Ov:${feedOv},${rapidOv},${spindleOv}>`
  if (sdFile) s = s.slice(0, -1) + `|SD:${sdFile},${sdPct}>`
  return s
}

// Bumped on soft reset so in-flight probe sleeps can detect invalidation.
let probeGeneration = 0

export function getProbeGeneration(): number {
  return probeGeneration
}

export function handleRealtime(byte: number): void {
  if      (byte === 0x21) { if (m.state === 'Run' || m.state === 'Jog') m.state = 'Hold' }
  else if (byte === 0x7E) { if (m.state === 'Hold') m.state = 'Run' }
  else if (byte === 0x18) { m.state = 'Idle'; m.feed = 0; m.spindle = 0; probeGeneration++ }
  else if (byte === 0x85) { if (m.state === 'Jog') m.state = 'Idle' }
  else if (byte === 0x90) { m.feedOv = 100 }
  else if (byte === 0x91) { m.feedOv = Math.min(200, m.feedOv + 10) }
  else if (byte === 0x92) { m.feedOv = Math.max(10, m.feedOv - 10) }
  else if (byte === 0x95) { m.rapidOv = 100 }
  else if (byte === 0x96) { m.rapidOv = 50 }
  else if (byte === 0x97) { m.rapidOv = 25 }
  else if (byte === 0x99) { m.spindleOv = 100 }
  else if (byte === 0x9A) { m.spindleOv = Math.min(200, m.spindleOv + 10) }
  else if (byte === 0x9B) { m.spindleOv = Math.max(10, m.spindleOv - 10) }
}

const JOG_RE     = /\$J=.*?F(\d+(?:\.\d+)?)\s+([XYZABC])(-?\d+(?:\.\d+)?)/i
const ZERO_RE    = /G10\s+L20\s+P0\s+([XYZABC])(-?\d+(?:\.\d+)?)/i
const MOVE_RE    = /G91\s+G0\s+([XYZ])(-?\d+(?:\.\d+)?)/i
const ABS_MOVE_RE = /G90\s+G53\s+G0\s+([XYZ])(-?\d+(?:\.\d+)?)/i
const SPINDLE_RE = /S(\d+)\s+(M3|M4)/i

type SendFn = (msg: string) => void

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Advance the simulated clock by ms, pausing while feed hold is active.
// Resolves false when a soft reset invalidates the motion mid-wait.
async function waitMotion(ms: number, generation: number): Promise<boolean> {
  let waited = 0
  while (waited < ms || m.state === 'Hold') {
    if (probeGeneration !== generation) return false
    if (m.state === 'Hold') { await sleep(50); continue }
    const step = Math.min(50, ms - waited)
    await sleep(step)
    waited += step
  }
  return probeGeneration === generation
}

export async function handleTextCommand(cmd: string, send: SendFn, queuedGeneration = probeGeneration): Promise<boolean> {
  cmd = cmd.trim()
  if (!cmd || cmd.startsWith('PING')) return true

  // A soft reset invalidates queued commands that move or change offsets;
  // read-only and status commands stay valid after a reset.
  if (queuedGeneration !== probeGeneration && (
    /\bG38\.\d\b/i.test(cmd) || ZERO_RE.test(cmd)
    || MOVE_RE.test(cmd) || ABS_MOVE_RE.test(cmd) || JOG_RE.test(cmd)
  )) return false

  if (cmd === '?') { send(statusReport() + '\n'); return true }

  if (cmd === '$H' || cmd.toUpperCase() === '$HOME') {
    m.state = 'Home'; m.feed = 2000
    await sleep(1500)
    m.wpos = [0, 0, 0]; m.mpos = [0, 0, 0]; m.state = 'Idle'; m.feed = 0
    send('ok\n'); return true
  }

  let match = cmd.match(/\$H([XYZABC])/i)
  if (match) {
    const i = AXIS[match[1].toUpperCase()] ?? 0
    m.state = 'Home'
    await sleep(800)
    m.wpos[i] = m.mpos[i] = 0
    m.state = 'Idle'
    send('ok\n'); return true
  }

  match = cmd.match(JOG_RE)
  if (match) {
    const feed = parseFloat(match[1])
    const i    = AXIS[match[2].toUpperCase()] ?? 0
    const dist = parseFloat(match[3])
    m.state = 'Jog'; m.feed = Math.round(feed)
    await sleep(Math.min(Math.abs(dist) / (feed / 60) * 1000, 2000))
    if (m.state === 'Jog') {
      if (i < m.wpos.length) { m.wpos[i] += dist; m.mpos[i] += dist }
      m.state = 'Idle'; m.feed = 0
    }
    send('ok\n'); return true
  }

  // Probe commands carry G38.x plus F and axis words in either order.
  if (/\bG38\.\d\b/i.test(cmd)) {
    const feedMatch = cmd.match(/\bF(\d+(?:\.\d+)?)\b/i)
    const axisMatch = cmd.match(/\b([XYZ])(-?\d+(?:\.\d+)?)\b/i)
    if (feedMatch && axisMatch) {
      const feed = parseFloat(feedMatch[1])
      const i    = AXIS[axisMatch[1].toUpperCase()] ?? 0
      const dist = parseFloat(axisMatch[2])
      const generation = probeGeneration
      // Preserve an active feed hold: the probe only starts moving once the
      // realtime resume (0x7E) flips Hold to Run, and waitMotion gates on it.
      if (m.state !== 'Hold') m.state = 'Run'
      m.feed = Math.round(feed)
      // Feed hold pauses the probe; a soft reset during the wait invalidates
      // it: leave the state untouched and emit nothing rather than a stale PRB.
      if (!(await waitMotion(Math.min(Math.abs(dist / 2) / (feed / 60) * 1000, 3000), generation))) return false
      // The guarded G38.3 descent ends in air in the demo: run the full
      // distance and report no contact; other probes stop on a simulated hit.
      const guarded = /\bG38\.3\b/i.test(cmd)
      const travel = guarded ? dist : dist / 2
      if (i < m.wpos.length) { m.wpos[i] += travel; m.mpos[i] += travel }
      m.state = 'Idle'; m.feed = 0
      // GRBL/FluidNC report PRB in machine coordinates.
      send(`[PRB:${m.mpos[0].toFixed(3)},${m.mpos[1].toFixed(3)},${m.mpos[2].toFixed(3)}:${guarded ? 0 : 1}]\n`)
      send('ok\n'); return true
    }
  }

  match = cmd.match(MOVE_RE)
  if (match) {
    const i    = AXIS[match[1].toUpperCase()] ?? 0
    const dist = parseFloat(match[2])
    // Queued rapids wait out an active feed hold; a soft reset drops them.
    if (!(await waitMotion(0, queuedGeneration))) return false
    if (i < m.wpos.length) { m.wpos[i] += dist; m.mpos[i] += dist }
    send('ok\n'); return true
  }

  match = cmd.match(ABS_MOVE_RE)
  if (match) {
    // Absolute machine-coordinate move: park MPos at the target while
    // carrying the active work offset over, so the following G10 L20 can
    // re-zero WPos alone instead of both positions collapsing onto it.
    const i      = AXIS[match[1].toUpperCase()] ?? 0
    const target = parseFloat(match[2])
    if (!(await waitMotion(0, queuedGeneration))) return false
    if (i < m.mpos.length) {
      const offset = m.mpos[i] - m.wpos[i]
      m.mpos[i] = target
      m.wpos[i] = target - offset
    }
    send('ok\n'); return true
  }

  match = cmd.match(SPINDLE_RE)
  if (match) { m.spindle = parseInt(match[1]); send('ok\n'); return true }

  if (/^M5\b/i.test(cmd)) { m.spindle = 0; send('ok\n'); return true }

  match = cmd.match(ZERO_RE)
  if (match) {
    const i = AXIS[match[1].toUpperCase()] ?? 0
    if (i < m.wpos.length) m.wpos[i] = parseFloat(match[2])
    send('ok\n'); return true
  }

  if (cmd === '$SS') {
    send('[MSG:INFO: FluidNC v3.8 (Simulator)]\n')
    send('[MSG:INFO: Connecting to STA SSID: SimNet]\n')
    send('[MSG:INFO: Connected - IP is 127.0.0.1]\n')
    send('[MSG:INFO: Probe Pin: GPIO_22]\n')
    send('ok\n'); return true
  }

  if (cmd === '$X') { m.state = 'Idle'; send('ok\n'); return true }

  if (cmd === '$Motors/Disable') {
    send('[MSG:INFO: Motors disabled]\n')
    send('ok\n'); return true
  }

  match = cmd.match(/\$SD\/Run=(.*)/i)
  if (match) { runSdJob(match[1], send); return true }

  send('ok\n')
  return true
}

async function runSdJob(fname: string, send: SendFn): Promise<void> {
  m.state = 'Run'; m.sdFile = fname; m.sdPct = 0; m.feed = 1500
  for (let pct = 0; pct <= 100; pct += 5) {
    if (m.state !== 'Run') break
    m.sdPct = pct
    await sleep(400)
  }
  m.state = 'Idle'; m.sdFile = null; m.sdPct = 0; m.feed = 0
  try { send('ok\n') } catch { /* noop */ }
}
