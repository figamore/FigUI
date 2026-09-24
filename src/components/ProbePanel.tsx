import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleDot, Crosshair, Pause, Play, Square, Target } from 'lucide-react'
import {
  onLine,
  onSoftReset,
  resumeBackgroundTraffic,
  sendRaw,
  sendRealtime,
  suspendBackgroundTraffic,
} from '../lib/ws'
import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'
import { displayToMm, feedUnitLabel, linearUnitLabel, mmToDisplay } from '../lib/units'
import { parseProbePoint, type ProbePoint } from '../lib/fluidncReports'
import { ParallelResultsModal, type ParallelRun } from './ParallelResultsModal'

type Axis = 'X' | 'Y' | 'Z'
type Side = 'negative' | 'positive'
type CycleId = 'z-surface' | 'x-negative' | 'x-positive' | 'y-negative' | 'y-positive'
  | 'x-center' | 'y-center' | 'bore-center' | 'rectangle-center' | 'parallelism'

interface RunningCycle { id: CycleId; phase: string; first?: number }
type ProbeStepState = 'idle' | 'pending' | 'active' | 'completed'

const PROBE_ALARM_MESSAGES: Record<number, string> = {
  1: 'Hard limit triggered',
  2: 'Soft limit exceeded',
  3: 'Cycle aborted',
  4: 'Probe fail — initial state',
  5: 'Probe fail — no contact',
  13: 'Hard stop',
  14: 'Machine is unhomed',
  17: 'G-code command error',
  18: 'Probe hard limit',
}

const CYCLES: Array<{ id: CycleId; label: string; short: string; group: 'edge' | 'center' | 'parallel' }> = [
  { id: 'z-surface', label: 'Z surface', short: 'Z−', group: 'edge' },
  { id: 'x-negative', label: 'Probe X−', short: 'X−', group: 'edge' },
  { id: 'x-positive', label: 'Probe X+', short: 'X+', group: 'edge' },
  { id: 'y-negative', label: 'Probe Y−', short: 'Y−', group: 'edge' },
  { id: 'y-positive', label: 'Probe Y+', short: 'Y+', group: 'edge' },
  { id: 'x-center', label: 'X center', short: 'X ⊕', group: 'center' },
  { id: 'y-center', label: 'Y center', short: 'Y ⊕', group: 'center' },
  { id: 'bore-center', label: 'Bore center', short: '○ ⊕', group: 'center' },
  { id: 'rectangle-center', label: 'Rectangle center', short: '▭ ⊕', group: 'center' },
  { id: 'parallelism', label: 'Parallelism', short: '∥', group: 'parallel' },
]

const CYCLE_INSTRUCTIONS: Record<CycleId, string> = {
  'z-surface': 'Position the probe above the touch plate or work surface, then verify the plate thickness.',
  'x-negative': 'Position the probe on the X+ side of the target face with a clear path for X− travel.',
  'x-positive': 'Position the probe on the X− side of the target face with a clear path for X+ travel.',
  'y-negative': 'Position the probe on the Y+ side of the target face with a clear path for Y− travel.',
  'y-positive': 'Position the probe on the Y− side of the target face with a clear path for Y+ travel.',
  'x-center': 'Start between the opposing X faces near center, with both faces within the configured travel.',
  'y-center': 'Start between the opposing Y faces near center, with both faces within the configured travel.',
  'bore-center': 'Start inside the bore near center. The cycle touches X−/X+, centers X, then touches Y−/Y+ and sets X0 Y0.',
  'rectangle-center': 'Start inside the feature near center. The cycle touches X−/X+, centers X, then touches Y−/Y+ and sets X0 Y0.',
  parallelism: 'Probe an edge or surface at several points to measure parallelism/straightness. Start at the first point — the scan advances in the +step direction. For X/Y edges set the Z height first; Z stays constant during the scan.',
}

const TOOLSETTER_ONLY_HINT = 'Only a toolsetter is configured. Only Z-height setting is available; X/Y and center probing require a probe input.'

function usePersisted<T>(key: string, init: T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) return JSON.parse(raw) as T
    } catch { /* use default */ }
    return init
  })
  function persist(v: T) {
    localStorage.setItem(key, JSON.stringify(v))
    setVal(v)
  }
  return [val, persist]
}

function number(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0
}

function alarmMessageFromLine(line: string): string | null {
  const activeAlarm = line.match(/^Active alarm:\s*(\d+)\s*(?:\(([^)]+)\))?/i)
  if (activeAlarm) {
    const code = Number(activeAlarm[1])
    return activeAlarm[2]?.trim() || PROBE_ALARM_MESSAGES[code] || `Controller alarm ${code}`
  }

  const alarmCode = line.match(/^ALARM:(\d+)$/i)
    || line.match(/^<Alarm(?::(\d+))?(?:[|>])/i)
  if (alarmCode) {
    const code = Number(alarmCode[1])
    return PROBE_ALARM_MESSAGES[code] || (Number.isFinite(code) ? `Controller alarm ${code}` : 'Controller alarm')
  }

  const namedAlarm = line.match(/\[MSG:(?:INFO|ERR):\s*ALARM:\s*(.+?)\]/i)
  return namedAlarm?.[1]?.trim() || null
}

function axisValue(point: ProbePoint, axis: Axis) {
  return point[axis.toLowerCase() as keyof ProbePoint]
}

function moveWord(axis: Axis, side: Side, distance: number) {
  return `${axis}${side === 'negative' ? '-' : ''}${number(distance)}`
}

function ProbeGraphic({
  cycle,
  running,
  held,
  cycleCompleted,
}: {
  cycle: CycleId
  running?: RunningCycle | null
  held?: boolean
  cycleCompleted?: boolean
}) {
  const isZ = cycle === 'z-surface'
  const isBore = cycle === 'bore-center'
  const isRectangle = cycle === 'rectangle-center'
  const centerAxis = cycle === 'x-center' ? 'X' : cycle === 'y-center' ? 'Y' : null
  const side = cycle.includes('negative') ? 'negative' : 'positive'
  const axis = cycle.startsWith('x-') ? 'X' : cycle.startsWith('y-') ? 'Y' : null
  const horizontal = axis === 'X'
  const arrow = side === 'negative'
    ? horizontal ? 'M68 60 H39' : 'M60 68 V39'
    : horizontal ? 'M52 60 H81' : 'M60 52 V81'
  const edgeProbeX = horizontal ? (side === 'negative' ? 78 : 42) : 60
  const edgeProbeY = horizontal ? 60 : (side === 'negative' ? 78 : 42)
  const id = cycle.replace(/-/g, '')

  function activeCenterStep() {
    if (!running || running.id !== cycle) return null
    const bothAxes = cycle === 'bore-center' || cycle === 'rectangle-center'
    if (running.phase === 'x-negative') return 1
    if (running.phase === 'x-positive') return 2
    if (running.phase === 'y-negative') return bothAxes ? 3 : 1
    if (running.phase === 'y-positive') return bothAxes ? 4 : 2
    return null
  }

  const currentStep = activeCenterStep()

  function stepState(step: number): ProbeStepState {
    if (cycleCompleted) return 'completed'
    if (currentStep == null) return 'idle'
    if (step < currentStep) return 'completed'
    if (step === currentStep) return 'active'
    return 'pending'
  }

  const TopProbe = ({ x = 60, y = 60 }: { x?: number; y?: number }) => <g>
    <circle cx={x} cy={y} r="10" fill={`url(#probeMetal${id})`} stroke="var(--text-muted)" strokeWidth="1.2" />
    <circle cx={x} cy={y} r="6.5" fill="var(--surface)" stroke="var(--border-strong)" />
    <circle cx={x} cy={y} r="2.7" fill="var(--accent)" />
    <path d={`M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x + 4} ${y - 4} L${x - 4} ${y + 4}`}
      stroke="var(--text-dim)" strokeWidth=".7" />
  </g>

  const Datum = ({ x, y, label }: { x: number; y: number; label: string }) => <g>
    <circle cx={x} cy={y} r="3.7" fill="var(--surface)" stroke="var(--ok)" strokeWidth="1.6" />
    <circle cx={x} cy={y} r="1.4" fill="var(--ok)" />
    <text x={x + 5} y={y - 5} fill="var(--ok)" fontSize="8" fontWeight="700">{label}</text>
  </g>

  const SequenceBadge = ({ x, y, value }: { x: number; y: number; value: number }) => {
    const state = stepState(value)
    const color = state === 'completed'
      ? 'var(--ok)'
      : state === 'pending' ? 'var(--text-dim)' : 'var(--accent)'
    const fill = state === 'completed'
      ? 'rgb(var(--ok-rgb) / .16)'
      : state === 'active' ? 'rgb(var(--accent-rgb) / .14)' : 'var(--surface)'
    return <g>
      {state === 'active' && !held && <circle className="probe-step-pulse" cx={x} cy={y} r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" />}
      {state === 'active' && held && <circle cx={x} cy={y} r="9.5" fill="none" stroke="var(--warn)" strokeWidth="1" opacity=".45" />}
      <circle cx={x} cy={y} r="7.5" fill={fill} stroke={color} strokeWidth={state === 'active' ? 2 : 1.4} />
      <text x={x} y={y + 3.5} textAnchor="middle" fill={color} fontSize="10" fontWeight="800">{value}</text>
    </g>
  }

  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" role="img" aria-label={`${cycle} probing diagram`}>
      <defs>
        <marker id={`probe-arrow-${cycle}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
          <path d="M0 0 L7 3.5 L0 7Z" fill="var(--accent)" />
        </marker>
        <marker id={`axis-x-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#ef4444" />
        </marker>
        <marker id={`axis-y-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#22c55e" />
        </marker>
        <marker id={`axis-z-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#3b82f6" />
        </marker>
        <linearGradient id={`probeMetal${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--surface)" />
          <stop offset=".48" stopColor="var(--border-strong)" />
          <stop offset="1" stopColor="var(--elevated)" />
        </linearGradient>
        <linearGradient id={`probePart${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--elevated)" />
          <stop offset="1" stopColor="var(--border)" />
        </linearGradient>
        <pattern id={`probeHatch${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={`url(#probePart${id})`} />
          <path d="M0 0 V6" stroke="var(--border-strong)" strokeWidth="1" opacity=".45" />
        </pattern>
        <filter id={`probeShadow${id}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity=".22" />
        </filter>
      </defs>
      <rect x="1" y="1" width="118" height="118" rx="8" fill="rgb(var(--accent-rgb) / .035)" stroke="var(--border)" />
      {axis && !centerAxis && <>
        <path d="M12 108 H31" stroke="#ef4444" strokeWidth="1.2" markerEnd={`url(#axis-x-${id})`} />
        <path d="M12 108 V89" stroke="#22c55e" strokeWidth="1.2" markerEnd={`url(#axis-y-${id})`} />
        <text x="35" y="111" fill="var(--text-dim)" fontSize="8">X+</text>
        <text x="4" y="84" fill="var(--text-dim)" fontSize="8">Y+</text>
      </>}
      {isZ ? <>
        <path d="M13 84 H107 V104 H13Z" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <path d="M13 84 H107" stroke="var(--ok)" strokeWidth="2" />
        <path d="M20 84 L27 77 H100 L93 84Z" fill="rgb(var(--accent-rgb) / .14)" stroke="var(--accent)" strokeWidth="1" />
        <TopProbe x={60} y={35} />
        <path d="M60 45 V81" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="5 3" markerEnd={`url(#probe-arrow-${cycle})`} />
        <text x="67" y="62" fill="var(--accent)" fontSize="9" fontWeight="800">Z−</text>
        <Datum x={60} y={84} label="Z0" />
        <path d="M101 77 V84 M97 77 H105 M97 84 H105" stroke="var(--text-muted)" strokeWidth=".9" />
        <text x="82" y="73" fill="var(--text-muted)" fontSize="8" fontWeight="700">PLATE</text>
      </> : isBore || isRectangle ? <>
        {isBore ? <>
          <circle cx="60" cy="60" r="46" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
          <circle cx="60" cy="60" r="35" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        </> : <>
          <rect x="10" y="10" width="100" height="100" rx="4" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
          <rect x="22" y="22" width="76" height="76" rx="3" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        </>}
        <path d="M27 60 H49 M93 60 H71 M60 27 V49 M60 93 V71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
        <path d="M49 60 L44 57 V63Z M71 60 L76 57 V63Z M60 49 L57 44 H63Z M60 71 L57 76 H63Z" fill="var(--accent)" />
        <circle cx="60" cy="60" r="15" fill="rgb(var(--accent-rgb) / .07)" stroke="var(--accent)" strokeDasharray="2 2" />
        <TopProbe x={60} y={60} />
        <path d="M48 60 H72 M60 48 V72" stroke="var(--ok)" strokeWidth=".8" />
        <SequenceBadge x={18} y={60} value={1} />
        <SequenceBadge x={102} y={60} value={2} />
        <SequenceBadge x={60} y={18} value={4} />
        <SequenceBadge x={60} y={102} value={3} />
      </> : centerAxis ? <>
        <rect x="10" y="10" width="100" height="100" rx="4" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <rect x="22" y="22" width="76" height="76" rx="3" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        {centerAxis === 'X'
          ? <><path d="M27 60 H49 M93 60 H71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
            <path d="M49 60 L44 57 V63Z M71 60 L76 57 V63Z" fill="var(--accent)" /></>
          : <><path d="M60 27 V49 M60 93 V71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
            <path d="M60 49 L57 44 H63Z M60 71 L57 76 H63Z" fill="var(--accent)" /></>}
        <TopProbe x={60} y={60} />
        <path d={centerAxis === 'X' ? 'M44 60 H76 M60 52 V68' : 'M52 60 H68 M60 43 V77'} stroke="var(--ok)" strokeWidth=".8" />
        <SequenceBadge x={centerAxis === 'X' ? 29 : 74} y={centerAxis === 'X' ? 48 : 29} value={1} />
        <SequenceBadge x={centerAxis === 'X' ? 91 : 74} y={centerAxis === 'X' ? 48 : 91} value={2} />
      </> : <>
        <path d={horizontal
          ? side === 'negative' ? 'M17 18 H40 V102 H17Z' : 'M80 18 H103 V102 H80Z'
          : side === 'negative' ? 'M18 17 H102 V40 H18Z' : 'M18 80 H102 V103 H18Z'}
          fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <path d={horizontal
          ? `M${side === 'negative' ? 40 : 80} 18 V102`
          : `M18 ${side === 'negative' ? 40 : 80} H102`} stroke="var(--ok)" strokeWidth="1.8" />
        <TopProbe x={edgeProbeX} y={edgeProbeY} />
        <path d={arrow} stroke="var(--accent)" strokeWidth="2.4" strokeDasharray="4 2" markerEnd={`url(#probe-arrow-${cycle})`} />
        <circle cx={horizontal ? (side === 'negative' ? 40 : 80) : 60} cy={horizontal ? 60 : (side === 'negative' ? 40 : 80)}
          r="3.2" fill="var(--surface)" stroke="var(--ok)" strokeWidth="1.5" />
        <text x={horizontal ? (side === 'negative' ? 20 : 85) : 69} y={horizontal ? 55 : (side === 'negative' ? 32 : 94)}
          fill="var(--ok)" fontSize="8.5" fontWeight="700">{axis}0</text>
        <text x={horizontal ? 54 : 72} y={horizontal ? 49 : (side === 'negative' ? 52 : 76)} fill="var(--accent)" fontSize="8" fontWeight="700">
          {axis}{side === 'negative' ? '−' : '+'}
        </text>
      </>}
    </svg>
  )
}

interface ParamRowProps {
  label: string; value: number; onChange: (v: number) => void; unit: string
  min?: number; isTablet?: boolean
}

interface SegRowProps {
  label: string
  value: string
  options: Array<{ value: string; label: string; title: string }>
  onChange: (value: string) => void
  disabled?: boolean
  disabledTitle?: string
  isTablet?: boolean
}

function SegRow({ label, value, options, onChange, disabled = false, disabledTitle, isTablet }: SegRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-text-muted font-semibold shrink-0 ${isTablet ? 'text-lg' : 'text-sm'}`}
        title={disabled ? disabledTitle : undefined}>{label}</span>
      <div className="flex gap-1">
        {options.map(option => <button
          key={option.value}
          type="button"
          disabled={disabled}
          title={disabled ? disabledTitle : option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`btn justify-center font-mono ${isTablet ? 'h-12 w-14 text-lg' : 'h-9 w-11 text-sm'} ${value === option.value ? 'btn-primary' : 'btn-ghost'}`}>
          {option.label}
        </button>)}
      </div>
    </div>
  )
}

// Schematic for the parallelism scan: an edge (X/Y plan view) or surface
// (Z side view) probed at several points along the step axis. The blue
// caption names the probe direction and sits centered above the arrow
// structure; the gray dashed scan path threads the numbered badges with an
// arrowhead at the +step end and its caption centered beneath the row.
function ParallelGraphic({
  probeAxis,
  side,
  stepAxis,
  npts,
  currentPoint,
  held,
  cycleCompleted,
}: {
  probeAxis: Axis
  side: Side
  stepAxis: 'X' | 'Y'
  npts: number
  currentPoint: number | null
  held?: boolean
  cycleCompleted?: boolean
}) {
  const isZ = probeAxis === 'Z'
  // X probe: plan view with horizontal arrows toward a vertical wall.
  const horizontal = probeAxis === 'X'
  // Show up to three representative scan positions.
  const shown = Math.min(Math.max(npts, 2), 3)
  const wallEdge = side === 'negative' ? 40 : 80
  const towardsNegative = side === 'negative'

  function pointState(i: number): ProbeStepState {
    if (cycleCompleted) return 'completed'
    if (currentPoint == null) return 'idle'
    if (i < currentPoint) return 'completed'
    if (i === currentPoint) return 'active'
    return 'pending'
  }

  const Probe = ({ x, y }: { x: number; y: number }) => <g>
    <circle cx={x} cy={y} r="9" fill="url(#parMetal)" stroke="var(--text-muted)" strokeWidth="1.2" />
    <circle cx={x} cy={y} r="5.5" fill="var(--surface)" stroke="var(--border-strong)" />
    <circle cx={x} cy={y} r="2.2" fill="var(--accent)" />
  </g>

  const Badge = ({ x, y, value }: { x: number; y: number; value: number }) => {
    const state = pointState(value - 1)
    const color = state === 'completed' ? 'var(--ok)' : state === 'pending' ? 'var(--text-dim)' : 'var(--accent)'
    const fill = state === 'completed'
      ? 'rgb(var(--ok-rgb) / .16)'
      : state === 'active' ? 'rgb(var(--accent-rgb) / .14)' : 'var(--surface)'
    return <g>
      {state === 'active' && !held && <circle className="probe-step-pulse" cx={x} cy={y} r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" />}
      <circle cx={x} cy={y} r="7.5" fill={fill} stroke={color} strokeWidth={state === 'active' ? 2 : 1.4} />
      <text x={x} y={y + 3.5} textAnchor="middle" fill={color} fontSize="10" fontWeight="800">{value}</text>
    </g>
  }

  // Point positions along the step axis (view coordinates): Z side view and
  // Y plan view read left→right (+X). X plan view steps +Y, which points
  // up-screen, so point 1 sits at the bottom and the row numbers upward;
  // its spread starts lower to keep the scan arrowhead clear of the caption.
  const positions = Array.from({ length: shown }, (_, i) => 24 + (i * 72) / (shown - 1))
  const xPositions = Array.from({ length: shown }, (_, i) => 30 + (i * 66) / (shown - 1))
  const zPositions = Array.from({ length: shown }, (_, i) => 36 + (i * 48) / (shown - 1))
  const badgeValue = (i: number) => (horizontal ? shown - i : i + 1)

  // Scan path geometry: horizontal through the badge row for Z/Y probes,
  // vertical through the badge column for X probes. The line extends past
  // the last badge so the arrowhead sits in clear space, not behind it.
  const badgeLane = towardsNegative ? 61.5 : 58.5
  const scanPath = isZ
    ? 'M16 68 H114'
    : horizontal
      ? `M${badgeLane} 105 V15`
      : `M16 ${badgeLane} H114`

  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" role="img" aria-label="Parallelism scan diagram">
      <defs>
        <marker id="parArrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
          <path d="M0 0 L7 3.5 L0 7Z" fill="var(--accent)" />
        </marker>
        <marker id="parScan" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto">
          <path d="M0 0 L6 3 L0 6Z" fill="var(--text-dim)" />
        </marker>
        <marker id="parAxisX" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#ef4444" />
        </marker>
        <marker id="parAxisY" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#22c55e" />
        </marker>
        <marker id="parAxisZ" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#3b82f6" />
        </marker>
        <linearGradient id="parMetal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--surface)" />
          <stop offset=".48" stopColor="var(--border-strong)" />
          <stop offset="1" stopColor="var(--elevated)" />
        </linearGradient>
        <linearGradient id="parPart" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--elevated)" />
          <stop offset="1" stopColor="var(--border)" />
        </linearGradient>
        <pattern id="parHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="url(#parPart)" />
          <path d="M0 0 V6" stroke="var(--border-strong)" strokeWidth="1" opacity=".45" />
        </pattern>
      </defs>
      <rect x="1" y="1" width="118" height="118" rx="8" fill="rgb(var(--accent-rgb) / .035)" stroke="var(--border)" />

      {/* Probe-direction caption, centered over the arrow structure. */}
      <text x="60" y="8.5" textAnchor="middle" fill="var(--accent)" fontSize="9" fontWeight="800">
        {probeAxis}{side === 'negative' ? '−' : '+'}
      </text>

      {/* Plane corner markers: X-Y for edge probes, Z-stepAxis side view for
          surface probes (Z-X / Z-Y). Compact, tucked into the bottom-left
          corner; colors match the single-surface axes. */}
      {(() => {
        const planeH = isZ ? stepAxis : 'X'
        const planeV = isZ ? 'Z' : 'Y'
        const axisColor = (a: string) => a === 'X' ? '#ef4444' : a === 'Y' ? '#22c55e' : '#3b82f6'
        const axisMarker = (a: string) => a === 'X' ? 'url(#parAxisX)' : a === 'Y' ? 'url(#parAxisY)' : 'url(#parAxisZ)'
        return <>
          <path d="M12 112 H26" stroke={axisColor(planeH)} strokeWidth="1.2" markerEnd={axisMarker(planeH)} />
          <path d="M12 112 V98" stroke={axisColor(planeV)} strokeWidth="1.2" markerEnd={axisMarker(planeV)} />
          <text x="30" y="115" fill="var(--text-dim)" fontSize="8">{planeH}+</text>
          <text x="2" y="95" fill="var(--text-dim)" fontSize="8">{planeV}+</text>
        </>
      })()}

      {/* Scan path threads the badges; the arrowhead marks the +step end. */}
      <path d={scanPath} stroke="var(--text-dim)" strokeWidth="1.2" strokeDasharray="2.5 3" markerEnd="url(#parScan)" />

      {isZ ? <>
        {/* Side view: plate centered in the view, probes above, badges on
            their own row between the arrows and the surface. */}
        <path d="M24 89 H96 V104 H24Z" fill="url(#parHatch)" stroke="var(--border-strong)" />
        <path d="M24 89 H96" stroke="var(--ok)" strokeWidth="2" />
        {zPositions.map(x => <g key={x}>
          <Probe x={x} y={25} />
          <path d={`M${x} 36 V56`} stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 2" markerEnd="url(#parArrow)" />
        </g>)}
        {zPositions.map((x, i) => <Badge key={x} x={x} y={68} value={i + 1} />)}
        <text x="60" y="85" textAnchor="middle" fill="var(--text-dim)" fontSize="7" fontWeight="700">SCAN +{stepAxis}</text>
        <text x="60" y="99" textAnchor="middle" fill="var(--text-muted)" fontSize="8" fontWeight="700">SURFACE</text>
      </> : <>
        {/* Plan view: wall on the probed side, probes opposite, badges on
            the arrows where the scan path crosses them. */}
        <path d={horizontal
          ? `M${wallEdge} 18 ${towardsNegative ? 'H17 V102' : 'H103 V102'} H${wallEdge}Z`
          : `M18 ${wallEdge} H102 ${towardsNegative ? 'V17 H18Z' : 'V103 H18Z'}`}
          fill="url(#parHatch)" stroke="var(--border-strong)" />
        <path d={horizontal ? `M${wallEdge} 18 V102` : `M18 ${wallEdge} H102`} stroke="var(--ok)" strokeWidth="1.8" />
        {horizontal
          ? <text x={towardsNegative ? 28.5 : 91.5} y={63}
              transform={`rotate(-90 ${towardsNegative ? 28.5 : 91.5} 63)`}
              textAnchor="middle" fill="var(--text-muted)" fontSize="8" fontWeight="700">EDGE</text>
          : <text x={60} y={towardsNegative ? 31 : 94} textAnchor="middle"
              fill="var(--text-muted)" fontSize="8" fontWeight="700">EDGE</text>}
        {positions.map((_, i) => {
          const pos = horizontal ? xPositions[i] : positions[i]
          const probeAt = towardsNegative ? wallEdge + 48 : wallEdge - 48
          const arrowStart = towardsNegative ? probeAt - 10 : probeAt + 10
          const arrowEnd = towardsNegative ? wallEdge + 5 : wallEdge - 5
          const arrow = horizontal
            ? `M${arrowStart} ${pos} H${arrowEnd}`
            : `M${pos} ${arrowStart} V${arrowEnd}`
          return <g key={pos}>
            <Probe x={horizontal ? probeAt : pos} y={horizontal ? pos : probeAt} />
            <path d={arrow} stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 2" markerEnd="url(#parArrow)" />
            <Badge x={horizontal ? badgeLane : pos}
              y={horizontal ? pos : badgeLane} value={badgeValue(i)} />
          </g>
        })}
        {/* Scan caption centered beneath the badge row/column. */}
        <text x={horizontal ? badgeLane : 60} y="113.5" textAnchor="middle"
          fill="var(--text-dim)" fontSize="7" fontWeight="700">SCAN +{stepAxis}</text>
      </>}
    </svg>
  )
}

function ParamRow({ label, value, onChange, unit, min = 0, isTablet }: ParamRowProps) {
  const [draftValue, setDraftValue] = useState(() => String(value))

  useEffect(() => {
    setDraftValue(String(value))
  }, [value])

  function commitValue() {
    const parsed = Number(draftValue.trim().replace(',', '.'))
    if (Number.isFinite(parsed) && parsed >= min) onChange(parsed)
    else setDraftValue(String(value))
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-text-muted font-semibold shrink-0 ${isTablet ? 'text-lg' : 'text-sm'}`}>{label}</span>
      <span className="flex items-center gap-1.5">
        <input type="text" inputMode="decimal" aria-label={label} value={draftValue}
          onChange={e => setDraftValue(e.target.value)} onBlur={commitValue}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className={`input-field font-mono text-right ${isTablet ? 'w-36 py-2 text-xl' : 'w-28 py-1 text-base'}`} />
        <span className={`text-text-dim shrink-0 ${isTablet ? 'text-lg w-20' : 'text-sm w-14'}`}>{unit}</span>
      </span>
    </div>
  )
}

function toDisplayInput(value: number, units: 'mm' | 'in', decimals: number) {
  return Number(mmToDisplay(value, units).toFixed(decimals))
}

export function ProbePanel({ isTablet, embedded = false }: { isTablet?: boolean; embedded?: boolean }) {
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const hasProbingInput = reportedHasProbe === true || reportedHasToolsetter === true
  const toolsetterOnly = reportedHasProbe === false && reportedHasToolsetter === true
  const [open, setOpen] = useState(embedded)
  const [selected, setSelected] = usePersisted<CycleId>('probe.cycle', 'z-surface')
  const [running, setRunning] = useState<RunningCycle | null>(null)
  const [probeHeld, setProbeHeld] = useState(false)
  const [completedCycle, setCompletedCycle] = useState<CycleId | null>(null)
  const runningRef = useRef<RunningCycle | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backgroundPausedRef = useRef(false)
  const [message, setMessage] = useState(() => CYCLE_INSTRUCTIONS[selected])
  const [probeFeed, setProbeFeed] = usePersisted('probe.feed', 100)
  const [maxTravel, setMaxTravel] = usePersisted('probe.travel', 50)
  const [retract, setRetract] = usePersisted('probe.retract', 3)
  const [plateThick, setPlateThick] = usePersisted('probe.plate', 0)
  const [probeDiameter, setProbeDiameter] = usePersisted('probe.diameter', 4)
  // Parallelism / straightness scan parameters (persisted in mm / mm-min)
  const [parallelAxis, setParallelAxis] = usePersisted<Axis>('probe.parallelAxis', 'X')
  const [parallelSide, setParallelSide] = usePersisted<Side>('probe.parallelSide', 'negative')
  const [parallelStepAxis, setParallelStepAxis] = usePersisted<'X' | 'Y'>('probe.parallelStepAxis', 'Y')
  const [parallelSlowFeed, setParallelSlowFeed] = usePersisted('probe.parallelSlowFeed', 20)
  const [parallelSafeZ, setParallelSafeZ] = usePersisted('probe.parallelSafeZ', 5)
  const [parallelLength, setParallelLength] = usePersisted('probe.parallelLength', 50)
  const [parallelPoints, setParallelPoints] = usePersisted('probe.parallelPoints', 5)
  const [parallelRun, setParallelRun] = useState<ParallelRun | null>(null)
  const parallelRunRef = useRef<ParallelRun | null>(null)
  const status = useMachineStore(s => s.status)
  const units = useMachineStore(s => s.units)
  const connected = useMachineStore(s => s.connected)
  const resetToolReference = useManualAtcStore(s => s.resetReference)
  const completeReferenceSetup = useManualAtcStore(s => s.completeReferenceSetup)
  const canProbe = connected && status.state === 'Idle'

  function updateRun(next: RunningCycle | null) {
    runningRef.current = next
    setRunning(next)
    if (!next) setProbeHeld(false)
  }

  function updateParallelRun(next: ParallelRun | null) {
    parallelRunRef.current = next
    setParallelRun(next)
  }

  // Mark the open parallelism run as failed (alarm, error, reset, timeout,
  // disconnect) so the results dialog releases its Close button.
  function failParallelRun() {
    const run = parallelRunRef.current
    if (run && !run.done && !run.failed) updateParallelRun({ ...run, failed: true })
  }

  // Upsert a probe hit into the open parallelism run and re-render.
  function recordParallelPoint(index: number, stepPos: number, value: number, final: boolean) {
    const run = parallelRunRef.current
    if (!run) return
    const points = run.points.filter(p => p.index !== index)
    points.push({ index, stepPos, value, final })
    points.sort((a, b) => a.index - b.index)
    updateParallelRun({ ...run, points })
  }

  // Axis coupling mirrors bCNC / gSender: X/Y probe along an edge with the
  // perpendicular step axis; Z probes downward over a surface with a
  // selectable X/Y step axis.
  function changeParallelAxis(axis: Axis) {
    setParallelAxis(axis)
    if (axis === 'X') setParallelStepAxis('Y')
    else if (axis === 'Y') setParallelStepAxis('X')
    else setParallelSide('negative')
  }

  function selectCycle(cycle: CycleId) {
    if (runningRef.current || (toolsetterOnly && cycle !== 'z-surface')) return
    setSelected(cycle)
    setCompletedCycle(null)
    setMessage(CYCLE_INSTRUCTIONS[cycle])
  }

  useEffect(() => {
    if (toolsetterOnly && selected !== 'z-surface' && !runningRef.current) {
      selectCycle('z-surface')
    }
  }, [toolsetterOnly, selected])

  function pauseBackgroundTraffic() {
    if (backgroundPausedRef.current) return
    backgroundPausedRef.current = true
    suspendBackgroundTraffic()
  }

  function restoreBackgroundTraffic() {
    if (!backgroundPausedRef.current) return
    backgroundPausedRef.current = false
    resumeBackgroundTraffic()
  }

  function armTimeout() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      restoreBackgroundTraffic()
      if (runningRef.current?.id === 'parallelism') failParallelRun()
      updateRun(null)
      setMessage('No probe contact report received. Check the probe and controller state.')
    }, 90_000)
  }

  function probe(axis: Axis, side: Side, distance = maxTravel) {
    sendRaw(`G21 G91 G38.2 F${number(probeFeed)} ${moveWord(axis, side, distance)}`)
    armTimeout()
  }

  function finish(messageText: string, markCycleCompleted = false) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    if (runningRef.current?.id === 'parallelism') failParallelRun()
    if (markCycleCompleted && runningRef.current) setCompletedCycle(runningRef.current.id)
    restoreBackgroundTraffic()
    updateRun(null)
    setMessage(messageText)
  }

  function finishAxisCenter(axis: Axis, first: number, second: number, continueWithY: boolean) {
    const midpoint = number((first + second) / 2)
    sendRaw(`G21 G91 G0 ${moveWord(axis, 'negative', retract)}`)
    sendRaw(`G90 G53 G0 ${axis}${midpoint}`)
    sendRaw(`G10 L20 P0 ${axis}0`)
    if (continueWithY) {
      const next = { id: runningRef.current!.id, phase: 'y-negative' }
      updateRun(next)
      setMessage('Points 1–2 complete. Point 3/4 — probing Y−…')
      probe('Y', 'negative')
    } else {
      sendRaw('G90')
      const featureCenter = runningRef.current?.id === 'bore-center' || runningRef.current?.id === 'rectangle-center'
      finish(featureCenter
        ? 'Feature center found and X/Y work zero set.'
        : `${axis} center found and ${axis} work zero set.`, true)
    }
  }

  useEffect(() => onLine(line => {
    const active = runningRef.current
    if (!active) return

    const alarmMessage = alarmMessageFromLine(line)
    if (alarmMessage) {
      finish(`Probe cycle stopped — ${alarmMessage}.`)
      return
    }

    const commandError = line.match(/^error:(\d+)$/i)
    if (commandError) {
      finish(`Probe command rejected by the controller (error ${commandError[1]}).`)
      return
    }

    const point = parseProbePoint(line)
    if (!point) return
    const radius = probeDiameter / 2

    if (active.id === 'z-surface') {
      sendRaw(`G10 L20 P0 Z${number(plateThick)}`)
      sendRaw(`G21 G91 G0 Z${number(retract)}`)
      sendRaw('G90')
      const referenceRegistered = !hasManualATC || completeReferenceSetup()
      finish(hasManualATC && referenceRegistered
        ? 'Z surface captured and the installed tool is now the tool-change reference.'
        : hasManualATC
          ? 'Z surface captured, but the tool-change reference could not be registered.'
          : 'Z surface captured and work offset updated.')
      return
    }

    const edgeMatch = active.id.match(/^([xy])-(negative|positive)$/)
    if (edgeMatch) {
      const axis = edgeMatch[1].toUpperCase() as Axis
      const side = edgeMatch[2] as Side
      const compensatedCoordinate = side === 'negative' ? radius : -radius
      sendRaw(`G10 L20 P0 ${axis}${number(compensatedCoordinate)}`)
      sendRaw(`G21 G91 G0 ${moveWord(axis, side === 'negative' ? 'positive' : 'negative', retract)}`)
      sendRaw('G90')
      finish(`${axis}${side === 'negative' ? '−' : '+'} edge captured with probe-radius compensation.`)
      return
    }

    if (active.id === 'parallelism') {
      const run = parallelRunRef.current
      const phaseMatch = active.phase.match(/^(\d+):(fast|slow)$/)
      if (!run || !phaseMatch) return
      const idx = Number(phaseMatch[1])
      const isSlow = phaseMatch[2] === 'slow'
      const away: Side = run.side === 'negative' ? 'positive' : 'negative'
      recordParallelPoint(
        idx,
        point[run.stepAxis.toLowerCase() as 'x' | 'y'],
        point[run.probeAxis.toLowerCase() as 'x' | 'y' | 'z'],
        isSlow,
      )
      if (!isSlow) {
        // Back off, then re-probe slowly for precision. Travel = 2×retract
        // so contact is guaranteed while the missed-trigger overshoot past
        // the known contact point stays bounded at one retract distance
        // (gsender/bCNC use travel = 2× their derived retract).
        sendRaw(`G21 G91 G0 ${moveWord(run.probeAxis, away, retract)}`)
        sendRaw(`G21 G91 G38.2 F${number(parallelSlowFeed)} ${moveWord(run.probeAxis, run.side, retract * 2)}`)
        updateRun({ id: 'parallelism', phase: `${idx}:slow` })
        armTimeout()
        return
      }
      // Slow pass recorded — settle, retract away from the surface.
      sendRaw('G4 P0.15')
      const lift = run.probeAxis === 'Z' ? parallelSafeZ : retract
      sendRaw(`G21 G91 G0 ${moveWord(run.probeAxis, away, lift)}`)
      if (idx + 1 < run.npts) {
        sendRaw(`G21 G91 G0 ${run.stepAxis}${number(run.stepMm)}`)
        sendRaw(`G21 G91 G38.2 F${number(probeFeed)} ${moveWord(run.probeAxis, run.side, maxTravel)}`)
        updateRun({ id: 'parallelism', phase: `${idx + 1}:fast` })
        setMessage(`Point ${idx + 2}/${run.npts} — probing ${run.probeAxis}${run.side === 'negative' ? '−' : '+'}…`)
        armTimeout()
      } else {
        // X/Y edge scans end with a Z lift to safe Z; Z scans already lifted.
        if (run.probeAxis !== 'Z') sendRaw(`G21 G91 G0 Z${number(parallelSafeZ)}`)
        sendRaw('G90')
        // recordParallelPoint updated the ref with the slow-pass value; the
        // run captured above is stale by one point.
        const completedRun = parallelRunRef.current
        if (completedRun) updateParallelRun({ ...completedRun, done: true })
        finish('Parallelism scan complete — results are in the dialog.', true)
      }
      return
    }

    const axis = active.phase.startsWith('x-') ? 'X' : 'Y'
    if (active.phase.endsWith('negative')) {
      const first = axisValue(point, axis)
      sendRaw(`G21 G91 G0 ${moveWord(axis, 'positive', retract)}`)
      const next = { ...active, phase: `${axis.toLowerCase()}-positive`, first }
      updateRun(next)
      const bothAxes = active.id === 'bore-center' || active.id === 'rectangle-center'
      const pointNumber = axis === 'Y' && bothAxes ? 4 : 2
      const total = bothAxes ? 4 : 2
      setMessage(`Point ${pointNumber - 1} complete. Point ${pointNumber}/${total} — probing ${axis}+…`)
      probe(axis, 'positive', maxTravel * 2)
      return
    }

    const second = axisValue(point, axis)
    const bothAxes = active.id === 'bore-center' || active.id === 'rectangle-center'
    finishAxisCenter(axis, active.first!, second, bothAxes && axis === 'X')
  }), [completeReferenceSetup, hasManualATC, maxTravel, parallelSafeZ, parallelSlowFeed, plateThick, probeDiameter, probeFeed, retract])

  useEffect(() => onSoftReset(() => {
    if (!runningRef.current) return
    finish('Probe cycle aborted by controller reset.')
  }), [])

  useEffect(() => {
    if (!runningRef.current || status.state !== 'Alarm') return
    const alarmMessage = status.alarmName
      || (status.alarmCode != null ? PROBE_ALARM_MESSAGES[status.alarmCode] : undefined)
      || 'Controller alarm'
    finish(`Probe cycle stopped — ${alarmMessage}.`)
  }, [status.state, status.alarmCode, status.alarmName])

  useEffect(() => {
    if (connected || !runningRef.current) return
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    if (runningRef.current.id === 'parallelism') failParallelRun()
    restoreBackgroundTraffic()
    updateRun(null)
    setMessage('Probe cycle interrupted because the controller disconnected.')
  }, [connected])

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (backgroundPausedRef.current) {
      backgroundPausedRef.current = false
      resumeBackgroundTraffic()
    }
  }, [])

  function runProbe() {
    if (!canProbe || running || (toolsetterOnly && selected !== 'z-surface')
      || probeFeed <= 0 || maxTravel <= 0 || retract <= 0) return
    setCompletedCycle(null)
    if (selected === 'z-surface' && hasManualATC && !resetToolReference()) {
      setMessage('Could not reset the tool-change reference before probing.')
      return
    }
    // Parallelism validation + axis coupling (coerced against stale config).
    let pAxis = parallelAxis
    let pStep = parallelStepAxis
    let pSide = parallelSide
    let npts = 0
    let stepMm = 0
    if (selected === 'parallelism') {
      if (pAxis === 'X') pStep = 'Y'
      else if (pAxis === 'Y') pStep = 'X'
      else pSide = 'negative'
      npts = Math.round(parallelPoints)
      if (npts < 2) {
        setMessage('Parallelism needs at least 2 probe points.')
        return
      }
      if (parallelLength <= 0 || parallelSafeZ <= 0 || parallelSlowFeed <= 0) {
        setMessage('Scan length, safe Z and slow feed must be positive.')
        return
      }
      if (parallelSafeZ >= maxTravel || retract >= maxTravel) {
        setMessage('Safe Z and retract must be smaller than max travel so each pass can reach the surface.')
        return
      }
      stepMm = parallelLength / (npts - 1)
    }
    pauseBackgroundTraffic()
    const edge = selected.match(/^([xy])-(negative|positive)$/)
    if (selected === 'z-surface') {
      updateRun({ id: selected, phase: 'z-negative' })
      setMessage('Probing Z− toward the work surface…')
      probe('Z', 'negative')
    } else if (selected === 'parallelism') {
      updateParallelRun({
        probeAxis: pAxis,
        stepAxis: pStep,
        side: pSide,
        npts,
        stepMm,
        points: [],
        failed: false,
        done: false,
      })
      updateRun({ id: 'parallelism', phase: '0:fast' })
      setMessage(`Point 1/${npts} — probing ${pAxis}${pSide === 'negative' ? '−' : '+'}…`)
      sendRaw(`G21 G91 G38.2 F${number(probeFeed)} ${moveWord(pAxis, pSide, maxTravel)}`)
      armTimeout()
    } else if (edge) {
      const axis = edge[1].toUpperCase() as Axis
      const side = edge[2] as Side
      updateRun({ id: selected, phase: `${axis.toLowerCase()}-${side}` })
      setMessage(`Probing ${axis}${side === 'negative' ? '−' : '+'}…`)
      probe(axis, side)
    } else {
      const axis: Axis = selected === 'y-center' ? 'Y' : 'X'
      const total = selected === 'bore-center' || selected === 'rectangle-center' ? 4 : 2
      updateRun({ id: selected, phase: `${axis.toLowerCase()}-negative` })
      setMessage(`Point 1/${total} — probing ${axis}−…`)
      probe(axis, 'negative')
    }
  }

  function holdProbe() {
    sendRealtime(0x21)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    restoreBackgroundTraffic()
    setProbeHeld(true)
  }

  function resumeProbe() {
    if (!runningRef.current) return
    pauseBackgroundTraffic()
    sendRealtime(0x7e)
    setProbeHeld(false)
    armTimeout()
  }

  function abortProbe() {
    if (!runningRef.current) return
    if (!confirm('Abort probing and reset the controller? Machine position may be lost.')) return
    sendRealtime(0x18)
  }

  const selectedCycle = CYCLES.find(c => c.id === selected)!
  const usesDiameter = selected !== 'z-surface' && selected !== 'parallelism'
  const selectedCycleUnavailable = toolsetterOnly && selected !== 'z-surface'
  const canRunSelectedCycle = canProbe && !selectedCycleUnavailable
  const parallelPhaseMatch = running?.id === 'parallelism' ? running.phase.match(/^(\d+):/) : null
  const parallelCurrentPoint = parallelPhaseMatch ? Number(parallelPhaseMatch[1]) : null

  if (!hasProbingInput) return null

  return (
    <div className={embedded ? '' : 'panel'}>
      {!embedded && <button className="panel-header w-full justify-between cursor-pointer hover:bg-elevated/50 transition-colors"
        onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <div className="flex items-center gap-2">
          <Target size={isTablet ? 20 : 15} />
          <span className="text-lg font-semibold">Probing</span>
        </div>
        <ChevronDown size={isTablet ? 20 : 15} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>}

      {open && <div className={`p-4 ${isTablet ? 'space-y-5' : 'space-y-4'}`}>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[.12em] text-text-dim mb-2">Single surface</div>
          <div className="grid grid-cols-5 gap-2">
            {CYCLES.filter(c => c.group === 'edge').map(c => <button key={c.id} onClick={() => selectCycle(c.id)}
              disabled={!!running || (toolsetterOnly && c.id !== 'z-surface')}
              title={toolsetterOnly && c.id !== 'z-surface' ? TOOLSETTER_ONLY_HINT : c.label}
              className={`btn justify-center font-mono ${isTablet ? 'h-14 text-xl' : 'h-10 text-base'} ${selected === c.id ? 'btn-primary' : 'btn-ghost'}`}>
              {c.short}
            </button>)}
          </div>
        </div>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[.12em] text-text-dim mb-2">Center finding</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CYCLES.filter(c => c.group === 'center').map(c => <button key={c.id} onClick={() => selectCycle(c.id)}
              disabled={!!running || toolsetterOnly}
              title={toolsetterOnly ? TOOLSETTER_ONLY_HINT : c.label}
              className={`btn min-w-0 justify-center whitespace-normal text-center leading-tight ${isTablet ? 'h-14 text-xl' : 'min-h-10 h-auto py-2 text-sm sm:h-10 sm:py-0 sm:text-base'} ${selected === c.id ? 'btn-primary' : 'btn-ghost'}`}>
              {c.label}
            </button>)}
          </div>
        </div>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[.12em] text-text-dim mb-2">Parallelism / straightness</div>
          <button onClick={() => selectCycle('parallelism')}
            disabled={!!running || toolsetterOnly}
            title={toolsetterOnly ? TOOLSETTER_ONLY_HINT : 'Probe an edge or surface at multiple points and measure deviation'}
            className={`btn w-full justify-center font-mono ${isTablet ? 'h-14 text-xl' : 'h-10 text-base'} ${selected === 'parallelism' ? 'btn-primary' : 'btn-ghost'}`}>
            Parallelism scan
          </button>
        </div>

        {selected === 'parallelism' ? (
          <div className={`grid grid-cols-1 gap-4 ${isTablet ? 'sm:grid-cols-[220px_1fr]' : 'sm:grid-cols-[150px_1fr]'}`}>
            <div className={`mx-auto w-full ${isTablet ? 'h-[220px] max-w-[220px]' : 'h-[220px] max-w-[220px] sm:h-[150px] sm:max-w-[150px]'}`}>
              <ParallelGraphic
                probeAxis={parallelAxis}
                side={parallelAxis === 'Z' ? 'negative' : parallelSide}
                stepAxis={parallelAxis === 'Z' ? parallelStepAxis : parallelAxis === 'X' ? 'Y' : 'X'}
                npts={Math.max(2, Math.round(parallelPoints))}
                currentPoint={parallelCurrentPoint}
                held={probeHeld}
                cycleCompleted={completedCycle === 'parallelism'}
              />
            </div>
            <div className={`rounded-md border border-border bg-elevated/30 p-3 ${isTablet ? 'space-y-4' : 'space-y-2'}`}>
              <SegRow isTablet={isTablet} label="Probe axis" value={parallelAxis}
                options={[
                  { value: 'X', label: 'X', title: 'Probe along X (edge). Step axis is Y.' },
                  { value: 'Y', label: 'Y', title: 'Probe along Y (edge). Step axis is X.' },
                  { value: 'Z', label: 'Z', title: 'Probe along Z (surface). Step axis is selectable.' },
                ]}
                onChange={v => changeParallelAxis(v as Axis)} />
              <SegRow isTablet={isTablet} label="Direction" value={parallelSide}
                options={[
                  { value: 'negative', label: '−', title: 'Probe toward the negative axis' },
                  { value: 'positive', label: '+', title: 'Probe toward the positive axis' },
                ]}
                onChange={v => setParallelSide(v as Side)}
                disabled={parallelAxis === 'Z'}
                disabledTitle="Z probing always moves down" />
              <SegRow isTablet={isTablet} label="Step axis" value={parallelStepAxis}
                options={[
                  { value: 'X', label: 'X', title: 'Step between points along X' },
                  { value: 'Y', label: 'Y', title: 'Step between points along Y' },
                ]}
                onChange={v => setParallelStepAxis(v as 'X' | 'Y')}
                disabled={parallelAxis !== 'Z'}
                disabledTitle="X/Y edge probing steps along the perpendicular axis" />
              <ParamRow isTablet={isTablet} label="Probe feed" value={toDisplayInput(probeFeed, units, units === 'in' ? 2 : 0)}
                onChange={v => setProbeFeed(displayToMm(v, units))} unit={feedUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Slow feed" value={toDisplayInput(parallelSlowFeed, units, units === 'in' ? 2 : 0)}
                onChange={v => setParallelSlowFeed(displayToMm(v, units))} unit={feedUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Max travel" value={toDisplayInput(maxTravel, units, units === 'in' ? 3 : 1)}
                onChange={v => setMaxTravel(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Retract" value={toDisplayInput(retract, units, units === 'in' ? 4 : 2)}
                onChange={v => setRetract(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .01 : .5} />
              <ParamRow isTablet={isTablet} label="Safe Z" value={toDisplayInput(parallelSafeZ, units, units === 'in' ? 4 : 2)}
                onChange={v => setParallelSafeZ(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .01 : .5} />
              <ParamRow isTablet={isTablet} label="Scan length" value={toDisplayInput(parallelLength, units, units === 'in' ? 3 : 1)}
                onChange={v => setParallelLength(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Points" value={parallelPoints}
                onChange={v => setParallelPoints(Math.max(2, Math.round(v)))} unit="pts" min={2} />
            </div>
          </div>
        ) : (
          <div className={`grid grid-cols-1 gap-4 ${isTablet ? 'sm:grid-cols-[220px_1fr]' : 'sm:grid-cols-[150px_1fr]'}`}>
            <div className={`mx-auto w-full ${isTablet ? 'h-[220px] max-w-[220px]' : 'h-[220px] max-w-[220px] sm:h-[150px] sm:max-w-[150px]'}`}>
              <ProbeGraphic
                cycle={selected}
                running={running}
                held={probeHeld}
                cycleCompleted={completedCycle === selected}
              />
            </div>
            <div className={`rounded-md border border-border bg-elevated/30 p-3 ${isTablet ? 'space-y-4' : 'space-y-2'}`}>
              <ParamRow isTablet={isTablet} label="Probe feed" value={toDisplayInput(probeFeed, units, units === 'in' ? 2 : 0)}
                onChange={v => setProbeFeed(displayToMm(v, units))} unit={feedUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Max travel" value={toDisplayInput(maxTravel, units, units === 'in' ? 3 : 1)}
                onChange={v => setMaxTravel(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .1 : 1} />
              <ParamRow isTablet={isTablet} label="Retract" value={toDisplayInput(retract, units, units === 'in' ? 4 : 2)}
                onChange={v => setRetract(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .01 : .5} />
              {usesDiameter && <ParamRow isTablet={isTablet} label="Probe diameter" value={toDisplayInput(probeDiameter, units, units === 'in' ? 4 : 2)}
                onChange={v => setProbeDiameter(displayToMm(v, units))} unit={linearUnitLabel(units)} min={0} />}
              {!usesDiameter && <ParamRow isTablet={isTablet} label="Plate thickness" value={toDisplayInput(plateThick, units, units === 'in' ? 4 : 2)}
                onChange={v => setPlateThick(displayToMm(v, units))} unit={linearUnitLabel(units)} min={0} />}
            </div>
          </div>
        )}

        <div className={`flex items-center gap-3 rounded-md border px-3 py-2 ${running ? 'border-warn/40 bg-warn/5 text-warn' : 'border-border bg-elevated/20 text-text-muted'}`}>
          {running ? <CircleDot className="shrink-0" size={18} /> : <Crosshair className="shrink-0" size={18} />}
          <span className={`${isTablet ? 'text-xl' : 'text-base'} flex-1`}>{message}</span>
        </div>

        <div className="flex gap-2">
          <button className={`btn flex-1 justify-center font-semibold gap-2 ${isTablet ? 'h-16 text-xl' : 'h-11 text-base'} ${canRunSelectedCycle && !running ? 'btn-warn' : 'btn-ghost'}`}
            onClick={runProbe} disabled={!canRunSelectedCycle || !!running}>
            <Target size={isTablet ? 22 : 17} />
            {running ? probeHeld ? 'Cycle held' : 'Cycle active' : selectedCycleUnavailable ? 'General probe required' : canProbe ? `Run ${selectedCycle.label}` : connected ? 'Machine not Idle' : 'Controller offline'}
          </button>
          {running && !probeHeld && <button
            className={`btn btn-danger justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`}
            onClick={holdProbe}>
            <Pause size={isTablet ? 22 : 17} /> Feed hold
          </button>}
          {running && probeHeld && <>
            <button className={`btn btn-ok justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`} onClick={resumeProbe}>
              <Play size={isTablet ? 22 : 17} /> Resume
            </button>
            <button className={`btn btn-danger justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`} onClick={abortProbe}>
              <Square className="fill-current" size={isTablet ? 20 : 15} /> Abort
            </button>
          </>}
        </div>
      </div>}

      {parallelRun && <ParallelResultsModal
        run={parallelRun}
        units={units}
        active={!!running && running.id === 'parallelism'}
        held={probeHeld}
        onHold={holdProbe}
        onResume={resumeProbe}
        onAbort={abortProbe}
        onClose={() => updateParallelRun(null)}
      />}
    </div>
  )
}
