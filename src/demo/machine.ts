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
  if (sdFile) s = s.slice(0, -1) + `|SD:${sdPct.toFixed(2)},${sdFile}>`
  return s
}

export function handleRealtime(byte: number): void {
  if      (byte === 0x21) { if (m.state === 'Run' || m.state === 'Jog') m.state = 'Hold' }
  else if (byte === 0x7E) { if (m.state === 'Hold') m.state = 'Run' }
  else if (byte === 0x18) { m.state = 'Idle'; m.feed = 0; m.spindle = 0 }
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
const PROBE_RE   = /G38\.\d\s+F(\d+(?:\.\d+)?)\s+Z(-\d+(?:\.\d+)?)/i
const SPINDLE_RE = /S(\d+)\s+(M3|M4)/i

type SendFn = (msg: string) => void

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function handleTextCommand(cmd: string, send: SendFn): Promise<void> {
  cmd = cmd.trim()
  if (!cmd || cmd.startsWith('PING')) return

  if (cmd === '?') { send(statusReport() + '\n'); return }

  if (cmd === '$H' || cmd.toUpperCase() === '$HOME') {
    m.state = 'Home'; m.feed = 2000
    await sleep(1500)
    m.wpos = [0, 0, 0]; m.mpos = [0, 0, 0]; m.state = 'Idle'; m.feed = 0
    send('ok\n'); return
  }

  let match = cmd.match(/\$H([XYZABC])/i)
  if (match) {
    const i = AXIS[match[1].toUpperCase()] ?? 0
    m.state = 'Home'
    await sleep(800)
    m.wpos[i] = m.mpos[i] = 0
    m.state = 'Idle'
    send('ok\n'); return
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
    send('ok\n'); return
  }

  match = cmd.match(PROBE_RE)
  if (match) {
    const feed = parseFloat(match[1])
    const dist = parseFloat(match[2])
    m.state = 'Run'; m.feed = Math.round(feed)
    await sleep(Math.min(Math.abs(dist / 2) / (feed / 60) * 1000, 3000))
    const cz = dist / 2
    m.wpos[2] += cz; m.mpos[2] += cz
    m.state = 'Idle'; m.feed = 0
    send(`[PRB:${m.wpos[0].toFixed(3)},${m.wpos[1].toFixed(3)},${m.wpos[2].toFixed(3)}:1]\n`)
    send('ok\n'); return
  }

  match = cmd.match(SPINDLE_RE)
  if (match) { m.spindle = parseInt(match[1]); send('ok\n'); return }

  if (/^M5\b/i.test(cmd)) { m.spindle = 0; send('ok\n'); return }

  match = cmd.match(ZERO_RE)
  if (match) {
    const i = AXIS[match[1].toUpperCase()] ?? 0
    if (i < m.wpos.length) m.wpos[i] = parseFloat(match[2])
    send('ok\n'); return
  }

  if (cmd === '$SS') {
    send('[MSG:INFO: FluidNC v3.8 (Simulator)]\n')
    send('[MSG:INFO: Connecting to STA SSID: SimNet]\n')
    send('[MSG:INFO: Connected - IP is 127.0.0.1]\n')
    send('ok\n'); return
  }

  if (cmd === '$X') { m.state = 'Idle'; send('ok\n'); return }

  if (cmd === '$Motors/Disable') {
    send('[MSG:INFO: Motors disabled]\n')
    send('ok\n'); return
  }

  match = cmd.match(/\$SD\/Run=(.*)/i)
  if (match) { runSdJob(match[1], send); return }

  send('ok\n')
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
