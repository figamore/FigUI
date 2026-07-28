import type { ControllerSettings, FluidNCSetting, GCodeModes, MachineStatus, MachineState, Position } from '../types'

export function parseStatusReport(raw: string): Partial<MachineStatus> | null {
  if (!raw.startsWith('<') || !raw.endsWith('>')) return null
  const parts = raw.slice(1, -1).split('|')
  const status: Partial<MachineStatus> = {}

  const stateParts = parts[0].split(':')
  status.state = stateParts[0] as MachineState
  if (stateParts[0] === 'Alarm' && stateParts[1]) {
    status.alarmCode = parseInt(stateParts[1], 10)
  } else if (stateParts[0] !== 'Alarm') {
    status.alarmCode = undefined
  }

  status.feed = 0
  status.spindle = 0

  let hasSd = false
  let hasPlannerLine = false
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('WPos:')) {
      status.wpos = parsePos(p.slice(5))
    } else if (p.startsWith('MPos:')) {
      status.mpos = parsePos(p.slice(5))
    } else if (p.startsWith('WCO:')) {
      status.wco = parsePos(p.slice(4))
    } else if (p.startsWith('FS:')) {
      const [f, s] = p.slice(3).split(',').map(Number)
      status.feed = f ?? 0
      status.spindle = s ?? 0
    } else if (p.startsWith('Ov:')) {
      const [f, r, s] = p.slice(3).split(',').map(Number)
      status.feedOverride = f ?? 100
      status.rapidOverride = r ?? 100
      status.spindleOverride = s ?? 100
    } else if (p.startsWith('Pn:')) {
      status.pinState = p.slice(3)
    } else if (p.startsWith('SD:')) {
      hasSd = true
      const sdParts = p.slice(3).split(',')
      // FluidNC format: SD:percent,filename
      status.sdPercent = parseFloat(sdParts[0]) || 0
      if (sdParts.length > 1) status.sdFilename = sdParts.slice(1).join(',')
    } else if (p.startsWith('Ln:')) {
      hasPlannerLine = true
      const lineNumber = Number.parseInt(p.slice(3), 10)
      status.plannerLineNumber = Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : undefined
    }
  }
  if (!hasSd) {
    status.sdPercent = undefined
    status.sdFilename = undefined
  }
  if (!hasPlannerLine) status.plannerLineNumber = undefined

  return status
}

function parsePos(str: string): Position {
  const [x, y, z, a, b, c] = str.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0, a, b, c }
}

// [ESP800]json=yes wraps the same fields the legacy "FW version:... #
// FW target:... # ..." plain-text response carried in {cmd,status,data}
// instead -- see WifiConfig.cpp's showFwInfoJSON()/wasm/FwInfo.cpp. Field
// names change shape too (e.g. "webcommunication:Sync:81:127.0.0.1"
// becomes separate WebCommunication/WebSocketPort/WebSocketIP fields, and
// "authentication:yes" becomes "Authentication":"Enabled") -- see
// App.tsx's resolveWsHost(), the only real consumer, for how those are
// read now.
export function parseESP800(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const data = (parsed as { data?: Record<string, unknown> })?.data
  if (!data) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = String(value)
  }
  return result
}

export function parseESP400Settings(raw: string): FluidNCSetting[] {
  if (!raw?.trim()) {
    throw new Error('Device returned an empty response for [ESP400].')
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    const preview = raw.slice(0, 200) + (raw.length > 200 ? '...' : '')
    throw new Error(`Could not parse settings response.\n\nReceived:\n${preview}`)
  }

  const j = json as Record<string, unknown>
  const list: FluidNCSetting[] =
    Array.isArray(json) ? (json as FluidNCSetting[]) :
    j.EEPROM            ? (j.EEPROM as FluidNCSetting[]) :
    j.data              ? [
        ...((j.data as Record<string, FluidNCSetting[]>).nvs  ?? []),
        ...((j.data as Record<string, FluidNCSetting[]>).tree ?? []),
      ] :
    []

  if (list.length === 0) {
    throw new Error(`Parsed OK but found no settings.\n\nResponse starts with:\n${raw.slice(0, 200)}`)
  }

  return list
}

const MODAL_GROUPS: Array<{ key: keyof GCodeModes; values: ReadonlySet<string> }> = [
  { key: 'motion', values: new Set(['G0', 'G1', 'G2', 'G3', 'G38.2', 'G38.3', 'G38.4', 'G38.5', 'G80']) },
  { key: 'wcs', values: new Set(['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3']) },
  { key: 'plane', values: new Set(['G17', 'G18', 'G19']) },
  { key: 'units', values: new Set(['G20', 'G21']) },
  { key: 'distance', values: new Set(['G90', 'G91']) },
  { key: 'arcDistance', values: new Set(['G90.1', 'G91.1']) },
  { key: 'feedRateMode', values: new Set(['G93', 'G94', 'G95']) },
  { key: 'cutterComp', values: new Set(['G40', 'G41', 'G42']) },
  { key: 'toolLength', values: new Set(['G43.1', 'G49']) },
  { key: 'programState', values: new Set(['M0', 'M1', 'M2', 'M30']) },
  { key: 'spindle', values: new Set(['M3', 'M4', 'M5']) },
  { key: 'coolant', values: new Set(['M7', 'M8', 'M9']) },
]

export function parseGcStateLine(line: string): Partial<MachineStatus> | null {
  const match = line.match(/^\[GC:(.+)\]$/)
  if (!match) return null

  const words = match[1].trim().split(/\s+/).filter(Boolean)
  const modal = new Set(words)

  const gcodeModes: GCodeModes = {}
  for (const group of MODAL_GROUPS) {
    for (const w of words) {
      if (group.values.has(w)) {
        gcodeModes[group.key] = w as never
        break
      }
    }
  }

  for (const w of words) {
    if (/^T\d+$/.test(w)) gcodeModes.tool = Number.parseInt(w.slice(1), 10)
    else if (/^F-?\d+(?:\.\d+)?$/.test(w)) gcodeModes.feed = Number.parseFloat(w.slice(1))
    else if (/^S-?\d+(?:\.\d+)?$/.test(w)) gcodeModes.spindleSpeed = Number.parseFloat(w.slice(1))
  }

  const result: Partial<MachineStatus> = { gcodeModes }
  const spindleValue = gcodeModes.spindleSpeed

  if (modal.has('M5')) {
    result.spindleRunning = false
    result.spindle = spindleValue ?? 0
  } else if (modal.has('M3') || modal.has('M4')) {
    result.spindleRunning = true
    if (spindleValue != null) result.spindle = spindleValue
  }

  return result
}

const CONTROLLER_SETTING_MAP: Record<string, keyof ControllerSettings> = {
  '11': 'junctionDeviation',
  '23': 'homingDirInvert',
  '30': 'spindleMax',
  '31': 'spindleMin',
  '100': 'stepsPerMmX',
  '101': 'stepsPerMmY',
  '102': 'stepsPerMmZ',
  '110': 'maxRateX',
  '111': 'maxRateY',
  '112': 'maxRateZ',
  '120': 'accelX',
  '121': 'accelY',
  '122': 'accelZ',
  '130': 'maxTravelX',
  '131': 'maxTravelY',
  '132': 'maxTravelZ',
}

export function parseControllerSettingLine(line: string): Partial<ControllerSettings> | null {
  const match = line.match(/^\$(11|23|30|31|100|101|102|110|111|112|120|121|122|130|131|132)=(-?\d+(?:\.\d+)?)(?:\s|$)/)
  if (!match) return null

  const value = Number.parseFloat(match[2])
  if (!Number.isFinite(value)) return null

  return { [CONTROLLER_SETTING_MAP[match[1]]]: value }
}

export function classifyLine(line: string): 'error' | 'alarm' | 'info' | 'ok' | 'status' | 'normal' {
  if (line.startsWith('error:') || line.includes('[MSG:ERR')) return 'error'
  if (line.startsWith('ALARM:') || line.includes('[MSG:WARN')) return 'alarm'
  if (line.includes('[MSG:INFO')) return 'info'
  if (line === 'ok') return 'ok'
  if ((line.startsWith('<') && line.endsWith('>')) || (line.startsWith('[GC:') && line.endsWith(']'))) return 'status'
  return 'normal'
}
