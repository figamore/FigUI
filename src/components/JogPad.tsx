import { useState, useCallback, useEffect, useRef } from 'react'
import { RotateCcw, Play, Square, ArrowLeft } from 'lucide-react'
import { useMachineStore } from '../store'
import { loadPersistedJogFeed } from '../lib/jog'
import { sendRaw, sendRealtime } from '../lib/ws'
import { setLocalJogActive } from '../lib/jogWatchdog'
import { useControllerJobStarting } from '../lib/jobState'
import type { Units } from '../types'
import {
  axisStepToCommand,
  displayToMm,
  feedUnitLabel,
  formatDisplayNumber,
  linearUnitLabel,
  mmToDisplay,
} from '../lib/units'

const MM_RING_STEPS = [0.1, 1, 10, 100] as const
const IN_RING_STEPS = [0.001, 0.01, 0.1, 1] as const
const RADII = [22, 40, 56, 74, 94] as const
const CONTINUOUS_DISTANCE = 10000
const MM_FEED_PRESETS = [50, 100, 200, 500, 1000, 2000, 3000] as const
const IN_FEED_PRESETS = [5, 10, 20, 50, 100, 200, 300] as const
const JOB_HIDE_DELAY_MS = 700

const RING_OPACITY = [0.12, 0.22, 0.35, 0.50]

const AX_COLOR: Record<string, string> = {
  X: 'var(--danger-rgb)',
  Y: 'var(--ok-rgb)',
}

const AX_HOVER: Record<string, string> = {
  X: 'var(--danger)',
  Y: 'var(--ok)',
}

function sendJogCancel() {
  sendRealtime(0x85)
}

function useJobRunningWithLinger(jobActive: boolean) {
  const [running, setRunning] = useState(jobActive)

  useEffect(() => {
    if (jobActive) {
      setRunning(true)
      return
    }

    const timeoutId = window.setTimeout(() => setRunning(false), JOB_HIDE_DELAY_MS)
    return () => window.clearTimeout(timeoutId)
  }, [jobActive])

  return running
}

/** Always capture pointer to prevent drift issues on mobile */
function alwaysCapturePointer(e: React.PointerEvent) {
  e.currentTarget.setPointerCapture(e.pointerId)
}

function tabletJogPointerHandlers(start: () => void, stop: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      alwaysCapturePointer(e)
      start()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  }
}

/**
 * Touch screens raise `contextmenu` on a long press, so holding a continuous
 * jog control pops the browser menu on release. Spread this onto a jog
 * container to swallow it - contextmenu bubbles, so children are covered too.
 * CSS alone is not enough: `-webkit-touch-callout` only suppresses the iOS
 * callout, and Chromium still fires the event.
 */
const noContextMenu = {
  onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
}

function arcPath(innerR: number, outerR: number, dir: number): string {
  const s = (dir - 0.5) * (Math.PI / 2)
  const e = (dir + 0.5) * (Math.PI / 2)
  const ix1 = innerR * Math.sin(s), iy1 = -innerR * Math.cos(s)
  const ix2 = innerR * Math.sin(e), iy2 = -innerR * Math.cos(e)
  const ox1 = outerR * Math.sin(s), oy1 = -outerR * Math.cos(s)
  const ox2 = outerR * Math.sin(e), oy2 = -outerR * Math.cos(e)
  if (innerR === 0)
    return `M0,0 L${ox1},${oy1} A${outerR},${outerR} 0 0,1 ${ox2},${oy2} Z`
  return `M${ix1},${iy1} L${ox1},${oy1} A${outerR},${outerR} 0 0,1 ${ox2},${oy2} L${ix2},${iy2} A${innerR},${innerR} 0 0,0 ${ix1},${iy1} Z`
}

function linearRingSteps(units: Units): readonly number[] {
  return units === 'in' ? IN_RING_STEPS : MM_RING_STEPS
}

function linearBarSteps(units: Units): readonly number[] {
  return units === 'in' ? [1, 0.1, 0.01] : [10, 1, 0.1]
}

function linearFeedPresets(units: Units): readonly number[] {
  if (units === 'in') return IN_FEED_PRESETS.map(preset => displayToMm(preset, 'in'))
  return MM_FEED_PRESETS
}

function snapToNearestPreset(value: number, presets: readonly number[]) {
  return presets.reduce((nearest, preset) =>
    Math.abs(preset - value) < Math.abs(nearest - value) ? preset : nearest
  , presets[0])
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function buildLimitedFeedPresets(presets: readonly number[], max?: number): number[] {
  if (max == null || !Number.isFinite(max) || max <= 0) return [...presets]

  const normalizedMax = Math.round(max * 1000) / 1000
  const limited = presets.filter(preset => preset <= normalizedMax)
  const next = limited.length > 0 ? [...limited] : [normalizedMax]
  if (!next.some(preset => Math.abs(preset - normalizedMax) < 0.001)) next.push(normalizedMax)
  return next
}

function buildSpindlePresets(min: number, max?: number): number[] {
  if (max == null || !Number.isFinite(max) || max <= 0) return [6000, 12000, 18000, 24000]

  const safeMin = Math.max(0, Math.round(min))
  const safeMax = Math.max(safeMin, Math.round(max))
  if (safeMax === 0) return [0]
  if (safeMax === safeMin) return [safeMax]

  const spread = safeMax - safeMin
  const raw = safeMin > 0
    ? [safeMin, safeMin + spread / 3, safeMin + (spread * 2) / 3, safeMax]
    : [safeMax / 4, safeMax / 2, (safeMax * 3) / 4, safeMax]

  return [...new Set(raw.map(value => Math.max(safeMin, Math.round(value))))]
}

interface SpindleRpmInputProps {
  value: number
  onChange: (value: number) => void
  className: string
}

function SpindleRpmInput({ value, onChange, className }: SpindleRpmInputProps) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const cancelBlurRef = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  function commit() {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false
      setDraft(String(value))
      setEditing(false)
      return
    }

    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    const next = Number.isFinite(parsed) ? parsed : value
    onChange(next)
    setDraft(String(next))
    setEditing(false)
  }

  return (
    <input
      type="number"
      value={draft}
      onFocus={e => {
        setEditing(true)
        e.currentTarget.select()
      }}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelBlurRef.current = true
          setDraft(String(value))
          e.currentTarget.blur()
        }
      }}
      step={100}
      className={className}
      placeholder="0"
    />
  )
}


function useHoldJog(
  axis: string, sign: 1 | -1, feed: number,
  step: number, continuous: boolean, disabled: boolean,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeRef = useRef(false)
  const setActiveStepJog = useMachineStore(state => state.setActiveStepJog)
  const fire = useCallback(() => {
    const dist = continuous ? sign * CONTINUOUS_DISTANCE : sign * step
    sendRaw(`$J=G91 G21 F${feed} ${axis}${dist}`)

    if (!continuous) {
      setActiveStepJog({
        active: true,
        startTime: Date.now(),
        expectedDistance: Math.abs(dist),
        axis: axis
      })
    }
  }, [axis, sign, feed, step, continuous, setActiveStepJog])

  const start = useCallback(() => {
    if (disabled) return
    activeRef.current = true
    setLocalJogActive(true)
    if (continuous) {
      fire()
    } else {
      fire()
    }
  }, [disabled, fire, continuous])

  const stop = useCallback(() => {
    const wasActive = activeRef.current
    activeRef.current = false
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    if (continuous && wasActive) sendJogCancel()
  }, [continuous])

  useEffect(() => {
    function stopAll() {
      stop()
    }

    window.addEventListener('blur', stopAll)
    document.addEventListener('visibilitychange', stopAll)

    return () => {
      window.removeEventListener('blur', stopAll)
      document.removeEventListener('visibilitychange', stopAll)
    }
  }, [stop])

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current) }, [])
  return { start, stop }
}

function RingWedge({ ringIdx, dir, axis, sign, feed, displayStep, commandStep, disabled, hover, onHover }: {
  ringIdx: number; dir: number; axis: string; sign: 1 | -1
  feed: number; disabled: boolean
  displayStep: number; commandStep: number
  hover: string | null; onHover: (id: string | null) => void
}) {
  const { start, stop } = useHoldJog(axis, sign, feed, commandStep, false, disabled)
  const id = `${axis}${sign > 0 ? '+' : '-'}${displayStep}`
  const isHovered = hover === id
  const axRgb = AX_COLOR[axis] ?? '100, 130, 200'
  const fill = isHovered
    ? (AX_HOVER[axis] ?? 'var(--accent)')
    : `rgba(${axRgb} / ${RING_OPACITY[ringIdx]})`

  return (
    <path
      d={arcPath(RADII[ringIdx], RADII[ringIdx + 1], dir)}
      fill={fill}
      stroke="var(--surface)" strokeWidth="1"
      className="cursor-pointer transition-colors duration-100"
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => { onHover(null); stop() }}
      onPointerDown={e => { alwaysCapturePointer(e); onHover(id); start() }}
      onPointerUp={() => { onHover(null); stop() }}
      onPointerCancel={() => { onHover(null); stop() }}
    />
  )
}


function ContWedge({ dir, axis, sign, feed, disabled, hover, onHover, activeKeys }: {
  dir: number; axis: string; sign: 1 | -1; feed: number
  disabled: boolean; hover: string | null; onHover: (id: string | null) => void
  activeKeys?: Set<string>
}) {
  const { start, stop } = useHoldJog(axis, sign, feed, 0, true, disabled)
  const id = `${axis}${sign > 0 ? '+' : '-'}cont`
  const isKeyActive = activeKeys?.has(`${axis}${sign > 0 ? '+' : '-'}`) ?? false
  const isHovered = hover === id || isKeyActive
  const axRgb = AX_COLOR[axis] ?? '100, 130, 200'
  const fill = isHovered
    ? (AX_HOVER[axis] ?? 'var(--accent)')
    : `rgba(${axRgb} / 0.25)`

  return (
    <path
      d={arcPath(RADII[0], RADII[RADII.length - 1], dir)}
      fill={fill}
      stroke="var(--surface)" strokeWidth="1"
      className="cursor-pointer transition-colors duration-100"
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => { onHover(null); stop() }}
      onPointerDown={e => { alwaysCapturePointer(e); onHover(id); start() }}
      onPointerUp={() => { onHover(null); stop() }}
      onPointerCancel={() => { onHover(null); stop() }}
    />
  )
}


const DIRS = [
  { axis: 'Y', sign: 1 as const,  dir: 0, label: '+Y', color: 'var(--ok)' },
  { axis: 'X', sign: 1 as const,  dir: 1, label: '+X', color: 'var(--danger)' },
  { axis: 'Y', sign: -1 as const, dir: 2, label: '−Y', color: 'var(--ok)' },
  { axis: 'X', sign: -1 as const, dir: 3, label: '−X', color: 'var(--danger)' },
]


function JogRose({ xyFeed, continuous, disabled, isJogging, activeKeys, units }: {
  xyFeed: number; continuous: boolean; disabled: boolean; isJogging: boolean
  activeKeys?: Set<string>
  units: Units
}) {
  const [hover, setHover] = useState<string | null>(null)
  const [centerHover, setCenterHover] = useState(false)
  const outerR = RADII[RADII.length - 1]
  const centerR = RADII[0]
  const ringSteps = linearRingSteps(units)

  const hoverAxis = hover && !hover.startsWith('c:') ? hover[0] : null
  const firstActiveAxis = activeKeys && activeKeys.size > 0 ? [...activeKeys][0][0] : null
  const hAxis = hoverAxis ?? firstActiveAxis
  const hStep = hover && !hover.startsWith('c:') && hover !== 'home'
    ? hover.replace(/^[A-Z][+-]/, '').replace('cont', '')
    : null
  const showStep = !!(hStep && hStep.length > 0)

  return (
    <svg viewBox="-100 -100 200 200"
      style={{ touchAction: 'none' }}
      {...noContextMenu}
      className={`w-full max-w-[280px] select-none ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>

      <defs>

        <filter id="jogShadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#000" floodOpacity="0.25" />
        </filter>
        <filter id="centerShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#000" floodOpacity="0.3" />
        </filter>
      </defs>

      <circle cx="0" cy="0" r={outerR + 2}
        fill="none" stroke="var(--border)" strokeWidth="1.5"
        filter="url(#jogShadow)" pointerEvents="none" />

      {continuous
        ? DIRS.map(d => (
            <ContWedge key={d.label} dir={d.dir} axis={d.axis} sign={d.sign}
              feed={xyFeed} disabled={disabled} hover={hover} onHover={setHover}
              activeKeys={activeKeys} />
          ))
        : [...ringSteps].reverse().map((_, ri) => {
            const ringIdx = ringSteps.length - 1 - ri
            return DIRS.map(d => (
              <RingWedge key={`${d.label}-${ringIdx}`}
                ringIdx={ringIdx} dir={d.dir} axis={d.axis} sign={d.sign}
                feed={xyFeed}
                displayStep={ringSteps[ringIdx]}
                commandStep={axisStepToCommand(ringSteps[ringIdx], d.axis, units)}
                disabled={disabled} hover={hover} onHover={setHover} />
            ))
          })
      }


      {!continuous && ringSteps.map((step, i) => {
        const midR = (RADII[i] + RADII[i + 1]) / 2
        const a1 = -Math.PI / 4
        const a2 = 3 * Math.PI / 4
        const x1 = midR * Math.cos(a1), y1 = midR * Math.sin(a1) + 6
        const x2 = midR * Math.cos(a2), y2 = midR * Math.sin(a2) + 2
        const label = formatDisplayNumber(step, units === 'in' ? 3 : 1)
        const fs = i === 0 ? 7 : 9
        return (
          <g key={step} pointerEvents="none">
            <text x={x1} y={y1} textAnchor="start"
              fill="var(--jog-step-label)" fontSize={fs} fontWeight="600"
              fontFamily="ui-monospace, monospace" opacity="0.7"
              transform={`rotate(45, ${x1}, ${y1})`}>
              {label}
            </text>
            <text x={x2} y={y2} textAnchor="start"
              fill="var(--jog-step-label)" fontSize={fs} fontWeight="500"
              fontFamily="ui-monospace, monospace" opacity="0.7"
              transform={`rotate(45, ${x2}, ${y2})`}>
              {label}
            </text>
          </g>
        )
      })}

      {DIRS.map(d => {
        const a = d.dir * (Math.PI / 2)
        const r = outerR - (RADII[RADII.length - 1] - RADII[RADII.length - 2]) / 2
        return (
          <text key={d.label} x={r * Math.sin(a)} y={-r * Math.cos(a)}
            textAnchor="middle" dominantBaseline="middle"
            fill={'white'}
            fontSize="10" fontWeight="700" pointerEvents="none">
            {d.label}
          </text>
        )
      })}

      <circle cx="0" cy="0" r={centerR}
        fill={isJogging ? (centerHover ? 'var(--danger)' : 'color-mix(in srgb, var(--danger) 25%, var(--elevated))') : 'var(--elevated)'}
        stroke={isJogging ? (centerHover ? 'var(--danger)' : 'color-mix(in srgb, var(--danger) 60%, var(--border))') : 'var(--border)'}
        strokeWidth="1.5"
        filter="url(#centerShadow)"
        className={isJogging ? 'cursor-pointer' : ''}
        onPointerEnter={isJogging ? () => setCenterHover(true) : undefined}
        onPointerLeave={isJogging ? () => setCenterHover(false) : undefined}
        onPointerDown={isJogging ? () => sendRealtime(0x85) : undefined}
      />
      <circle cx="0" cy="0" r={centerR - 3}
        fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="0.5"
        pointerEvents="none"
        fillOpacity={isJogging ? 0 : 1}
      />

      {isJogging ? (
        <g pointerEvents="none">
          <rect x="-6" y="-6" width="12" height="12" rx="1.5"
            fill={centerHover ? '#fff' : 'var(--danger)'} />
        </g>
      ) : showStep ? (
        <>
          <text x="0" y="-3" textAnchor="middle" dominantBaseline="middle"
            fill={DIRS.find(d => d.axis === hAxis)?.color ?? 'var(--accent)'}
            fontSize="14" fontWeight="700"
            fontFamily="ui-monospace, monospace" pointerEvents="none">
            {hStep}
          </text>
          <text x="0" y="11" textAnchor="middle" fill="var(--text-dim)"
            fontSize="7" pointerEvents="none">{linearUnitLabel(units)}</text>
        </>
      ) : continuous && (hover && !hover.startsWith('c:') && hover !== 'home') || (activeKeys && activeKeys.size > 0 && [...activeKeys].some(k => k[0] !== 'Z')) ? (
        <text x="0" y="1" textAnchor="middle" dominantBaseline="middle"
          fill={DIRS.find(d => d.axis === hAxis)?.color ?? 'var(--accent)'}
          fontSize="8" fontWeight="700" pointerEvents="none">HOLD</text>
      ) : (
        <g pointerEvents="none" opacity="0.35">
          <line x1="-8" y1="0" x2="8" y2="0" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="0" y1="-8" x2="0" y2="8" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="0" cy="0" r="3" fill="none" stroke="var(--text-muted)" strokeWidth="1" />
        </g>
      )}
    </svg>
  )
}

const ZONE_FILL = ['var(--jog-r0)', 'var(--jog-r1)', 'var(--jog-r2)']
const ABC_STEPS = [10, 1, 0.1]  as const

function AxisZone({ id, y, displayStep, commandStep, sign, axis, feed, fillIdx, color, disabled, hover, onHover }: {
  id: string; y: number; displayStep: number; commandStep: number; sign: 1 | -1; axis: string; feed: number
  fillIdx: number; color: string; disabled: boolean
  hover: string | null; onHover: (id: string | null) => void
}) {
  const { start, stop } = useHoldJog(axis, sign, feed, commandStep, false, disabled)
  const isHovered = hover === id
  return (
    <g className="cursor-pointer"
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => { onHover(null); stop() }}
      onPointerDown={e => { alwaysCapturePointer(e); onHover(id); start() }}
      onPointerUp={() => { onHover(null); stop() }}
      onPointerCancel={() => { onHover(null); stop() }}>
      <rect x="2" y={y} width="40" height="26" rx="2"
        fill={isHovered ? color : ZONE_FILL[fillIdx]}
        stroke="var(--surface)" strokeWidth="1.5" />
      <text x="22" y={y + 16} textAnchor="middle"
        fill={isHovered ? '#fff' : 'var(--jog-label)'}
        fontSize="12" fontWeight="700" fontFamily="ui-monospace, monospace"
        pointerEvents="none">
        {formatDisplayNumber(displayStep, displayStep < 1 ? 3 : 1)}
      </text>
    </g>
  )
}

function AxisCont({ id, y, h, sign, axis, feed, color, disabled, hover, onHover, activeKeys }: {
  id: string; y: number; h: number; sign: 1 | -1; axis: string; feed: number
  color: string; disabled: boolean; hover: string | null; onHover: (id: string | null) => void
  activeKeys?: Set<string>
}) {
  const { start, stop } = useHoldJog(axis, sign, feed, 0, true, disabled)
  const isKeyActive = activeKeys?.has(`${axis}${sign > 0 ? '+' : '-'}`) ?? false
  const isHovered = hover === id || isKeyActive
  return (
    <rect x="2" y={y} width="40" height={h} rx="3"
      fill={isHovered ? color : 'var(--jog-r1)'}
      stroke="var(--surface)" strokeWidth="1.5"
      className="cursor-pointer"
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => { onHover(null); stop() }}
      onPointerDown={e => { alwaysCapturePointer(e); onHover(id); start() }}
      onPointerUp={() => { onHover(null); stop() }}
      onPointerCancel={() => { onHover(null); stop() }}
    />
  )
}

function AxisBar({ axis, color, steps, feed, continuous, disabled, activeKeys, units }: {
  axis: string; color: string; steps: readonly number[]; feed: number
  continuous: boolean; disabled: boolean; activeKeys?: Set<string>; units: Units
}) {
  const [hover, setHover] = useState<string | null>(null)
  return (
    <svg viewBox="0 0 44 220"
      style={{ touchAction: 'none' }}
      {...noContextMenu}
      className={`w-[50px] h-full max-h-[260px] select-none shrink-0
                  ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>

      <rect x="2" y="0" width="40" height="24" rx="3" fill={color} opacity="0.15" />
      <text x="22" y="16" textAnchor="middle" fill={color} fontSize="12" fontWeight="700" pointerEvents="none">+{axis}</text>

      {continuous ? (
        <>
          <AxisCont id={`${axis}+c`} y={26} h={82} sign={1} axis={axis} feed={feed} color={color}
            disabled={disabled} hover={hover} onHover={setHover} activeKeys={activeKeys} />
          <AxisCont id={`${axis}-c`} y={116} h={82} sign={-1} axis={axis} feed={feed} color={color}
            disabled={disabled} hover={hover} onHover={setHover} activeKeys={activeKeys} />
        </>
      ) : (
        <>
          {steps.map((step, i) => (
            <AxisZone key={`+${step}`} id={`${axis}+${step}`} y={26 + i * 28}
              displayStep={step} commandStep={axisStepToCommand(step, axis, units)} sign={1}
              axis={axis} feed={feed} fillIdx={steps.length - 1 - i} color={color}
              disabled={disabled} hover={hover} onHover={setHover} />
          ))}
          <rect x="2" y="110" width="40" height="4" rx="1" fill="var(--border)" />
          {[...steps].reverse().map((step, i) => (
            <AxisZone key={`-${step}`} id={`${axis}-${step}`} y={116 + i * 28}
              displayStep={step} commandStep={axisStepToCommand(step, axis, units)} sign={-1}
              axis={axis} feed={feed} fillIdx={i} color={color}
              disabled={disabled} hover={hover} onHover={setHover} />
          ))}
        </>
      )}

      <rect x="2" y="200" width="40" height="20" rx="3" fill={color} opacity="0.15" />
      <text x="22" y="214" textAnchor="middle" fill={color} fontSize="12" fontWeight="700" pointerEvents="none">−{axis}</text>
    </svg>
  )
}


function OverrideRow({ label, value, maxValue = 200, onMinus, onReset, onPlus, isTablet }: {
  label: string; value: number; maxValue?: number; onMinus: () => void; onReset: () => void; onPlus: () => void; isTablet?: boolean
}) {
  const pct = Math.min(value, maxValue)
  const color = value > 100 ? 'var(--ok)' : value < 100 ? 'var(--warn)' : 'var(--accent)'
  return (
    <div className={`flex items-center ${isTablet ? 'gap-3 py-2' : 'gap-1.5'}`}>
      <span className={`text-text-muted ${isTablet ? 'font-bold' : 'font-medium'} shrink-0 ${isTablet ? 'text-xl w-24' : 'text-lg w-20'}`}>{label}</span>
      <button className={`${isTablet ? 'w-12 h-12 rounded-lg' : 'w-6 h-6 rounded'} border border-border text-text-muted hover:text-text-primary
                         hover:bg-elevated flex items-center justify-center`} onClick={onReset} title="Reset to 100%">
        <RotateCcw className={isTablet ? 'w-5 h-5' : 'w-3 h-3'} />
      </button>
      <button className={`${isTablet ? 'w-12 h-12 rounded-lg text-2xl' : 'w-6 h-6 rounded text-base'} border border-border text-text-muted hover:text-text-primary
                         hover:bg-elevated flex items-center justify-center leading-none`} onClick={onMinus}>−</button>
      <div className={`flex-1 flex items-center min-w-0 ${isTablet ? 'gap-3' : 'gap-1.5'}`}>
        <div className={`flex-1 bg-elevated rounded-full overflow-hidden ${isTablet ? 'h-6' : 'h-3'}`}>
          <div className="h-full rounded-full transition-all" style={{ width: `${(pct / maxValue) * 100}%`, background: color }} />
        </div>
        <span className={`font-mono text-center shrink-0 ${isTablet ? 'text-xl w-20' : 'text-base w-10'}`} style={{ color }}>{value}%</span>
      </div>
      <button className={`${isTablet ? 'w-12 h-12 rounded-lg text-2xl' : 'w-6 h-6 rounded text-base'} border border-border text-text-muted hover:text-text-primary
                         hover:bg-elevated flex items-center justify-center leading-none`} onClick={onPlus}>+</button>
    </div>
  )
}


function FeedButton({
  label,
  value,
  presets,
  onChange,
  formatValue,
  toDisplayValue,
  fromDisplayValue,
  max,
}: {
  label: string
  value: number
  presets: readonly number[]
  onChange: (v: number) => void
  formatValue: (v: number) => string
  toDisplayValue?: (v: number) => number
  fromDisplayValue?: (v: number) => number
  max?: number
}) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  function close() {
    setOpen(false)
    setCustomOpen(false)
    setCustomValue('')
  }

  function openCustom() {
    setCustomValue(String(toDisplayValue ? toDisplayValue(value) : value))
    setCustomOpen(true)
  }

  function commitCustom() {
    const displayValue = Number(customValue)
    if (!Number.isFinite(displayValue) || displayValue <= 0) return
    const converted = fromDisplayValue ? fromDisplayValue(displayValue) : displayValue
    onChange(max != null && Number.isFinite(max) ? Math.min(converted, max) : converted)
    close()
  }

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-base transition-all ${
          open
            ? 'bg-accent/10 border-accent/50 text-accent'
            : 'bg-elevated border-border text-text-primary hover:border-border-strong'
        }`}
      >
        <span className={`font-bold uppercase tracking-wider text-base shrink-0 ${open ? 'text-accent/80' : 'text-text-muted'}`}>{label}</span>
        <span className="font-mono flex-1 text-right">{formatValue(value)}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
        >
          <path d="M2 4l4 4 4-4"/>
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 right-0 bg-surface border border-border rounded shadow-lg z-50 overflow-hidden py-1">
          {presets.map(preset => (
            <button
              key={preset}
              onClick={() => { onChange(preset); close() }}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-base font-mono transition-colors ${
                preset === value
                  ? 'bg-accent/10 text-accent font-semibold'
                  : 'text-text-primary hover:bg-elevated'
              }`}
            >
              <span className="w-3.5 flex justify-center shrink-0">
                {preset === value && (
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                )}
              </span>
              <span>{formatValue(preset)}</span>
            </button>
          ))}
          {toDisplayValue && fromDisplayValue && (
            customOpen ? (
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border">
                <input
                  type="number"
                  value={customValue}
                  onChange={e => setCustomValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitCustom()
                    if (e.key === 'Escape') close()
                  }}
                  min={0}
                  step="any"
                  className="input-field min-w-0 flex-1 py-1 px-2 text-base font-mono text-right"
                  autoFocus
                />
                <button
                  className="btn btn-primary px-2 py-1 text-base"
                  onClick={commitCustom}
                  disabled={!Number.isFinite(Number(customValue)) || Number(customValue) <= 0}
                >
                  Set
                </button>
              </div>
            ) : (
              <button
                className="w-full px-3 py-1.5 text-left text-base text-text-muted hover:text-text-primary hover:bg-elevated border-t border-border transition-colors"
                onClick={openCustom}
              >
                Custom…
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

function useKeyboardJog(continuous: boolean, canJog: boolean, xyFeed: number, zFeed: number) {
  const [keyboardJog, setKeyboardJog] = useState(false)
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set())
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const fireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const xyFeedRef = useRef(xyFeed)
  const zFeedRef = useRef(zFeed)
  const canJogRef = useRef(false)

  useEffect(() => { xyFeedRef.current = xyFeed }, [xyFeed])
  useEffect(() => { zFeedRef.current = zFeed }, [zFeed])
  useEffect(() => { canJogRef.current = canJog }, [canJog])

  const resetKeyboardJog = useCallback(() => {
    if (fireTimerRef.current) { clearTimeout(fireTimerRef.current); fireTimerRef.current = null }
    const hadKeys = pressedKeysRef.current.size > 0
    pressedKeysRef.current.clear()
    setActiveKeys(new Set())
    if (hadKeys) sendJogCancel()
  }, [])

  useEffect(() => {
    if (!continuous) {
      setKeyboardJog(false)
      resetKeyboardJog()
    }
  }, [continuous, resetKeyboardJog])

  useEffect(() => {
    if (!keyboardJog) resetKeyboardJog()
  }, [keyboardJog, resetKeyboardJog])

  useEffect(() => {
    if (!canJog) resetKeyboardJog()
  }, [canJog, resetKeyboardJog])

  useEffect(() => {
    if (!continuous || !keyboardJog) return

    function fireJog() {
      if (!canJogRef.current) return
      const keys = pressedKeysRef.current
      if (keys.size === 0) return

      const hasXY = [...keys].some(k => k[0] === 'X' || k[0] === 'Y')
      const baseFeed = hasXY ? xyFeedRef.current : zFeedRef.current

      const numAxes = keys.size
      const vectorAdjustedFeed = Math.round(baseFeed * Math.sqrt(numAxes))

      const axes = [...keys].map(k => `${k[0]}${(k[1] === '+' ? 1 : -1) * CONTINUOUS_DISTANCE}`).join(' ')
      setLocalJogActive(true)
      sendRaw(`$J=G91 G21 F${vectorAdjustedFeed} ${axes}`)
    }

    function scheduleJog() {
      if (fireTimerRef.current) clearTimeout(fireTimerRef.current)
      sendRealtime(0x85)
      fireTimerRef.current = setTimeout(() => { fireTimerRef.current = null; fireJog() }, 10)
    }

    function handleKey(e: KeyboardEvent) {
      if (!canJogRef.current) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return

      let axis = '', sign: 1 | -1 = 1
      switch (e.key) {
        case 'ArrowRight': axis = 'X'; sign =  1; break
        case 'ArrowLeft':  axis = 'X'; sign = -1; break
        case 'ArrowUp':    axis = 'Y'; sign =  1; break
        case 'ArrowDown':  axis = 'Y'; sign = -1; break
        case '+': case '=': axis = 'Z'; sign =  1; break
        case '-':           axis = 'Z'; sign = -1; break
        default: return
      }
      e.preventDefault()
      if (e.repeat) return
      const dir = `${axis}${sign > 0 ? '+' : '-'}`
      const opp = `${axis}${sign > 0 ? '-' : '+'}`
      const keys = pressedKeysRef.current
      if (keys.has(dir)) return
      keys.delete(opp)
      keys.add(dir)
      setActiveKeys(new Set(keys))
      scheduleJog()
    }

    function handleKeyUp(e: KeyboardEvent) {
      let axis = ''
      switch (e.key) {
        case 'ArrowRight': case 'ArrowLeft': axis = 'X'; break
        case 'ArrowUp':    case 'ArrowDown': axis = 'Y'; break
        case '+': case '=': case '-':        axis = 'Z'; break
        default: return
      }
      e.preventDefault()
      const keys = pressedKeysRef.current
      keys.delete(`${axis}+`)
      keys.delete(`${axis}-`)
      setActiveKeys(new Set(keys))
      if (keys.size > 0) {
        scheduleJog()
      } else {
        if (fireTimerRef.current) { clearTimeout(fireTimerRef.current); fireTimerRef.current = null }
        sendJogCancel()
      }
    }

    function onInterrupt() { resetKeyboardJog() }
    function onVisibility() { if (document.visibilityState !== 'visible') resetKeyboardJog() }

    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', onInterrupt)
    window.addEventListener('pagehide', onInterrupt)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', onInterrupt)
      window.removeEventListener('pagehide', onInterrupt)
      document.removeEventListener('visibilitychange', onVisibility)
      resetKeyboardJog()
    }
  }, [continuous, keyboardJog, resetKeyboardJog])

  return { keyboardJog, setKeyboardJog, activeKeys }
}

export function JogPad() {
  const status = useMachineStore(s => s.status)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerJobStarting = useControllerJobStarting()
  const axes = useMachineStore(s => s.axes)
  const units = useMachineStore(s => s.units)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const setActiveStepJog = useMachineStore(s => s.setActiveStepJog)
  const [spindleTarget, setSpindleTarget] = useState(24000)
  const [selectedSpindlePreset, setSelectedSpindlePreset] = useState<number | null>(null)
  const [spindleOverrideState, setSpindleOverrideState] = useState<'on' | 'off' | null>(null)
  const [xyFeed, setXyFeed] = useState(() => loadPersistedJogFeed('jog.xyFeed', 1000))
  const [zFeed, setZFeed]   = useState(() => loadPersistedJogFeed('jog.zFeed', 200))
  const [abcFeed, setAbcFeed] = useState(() => loadPersistedJogFeed('jog.abcFeed', 500))
  const [continuous, setContinuous] = useState(false)
  const [compact, setCompact] = useState(() => localStorage.getItem('jog.desktopStyle') === 'compact')
  const prevUnitsRef = useRef(units)

  const jobActive = status.state === 'Run' || status.state === 'Hold' || controllerJobStarting || controllerResetPending
  const canJog = (status.state === 'Idle' || status.state === 'Jog') && !controllerJobStarting && !controllerResetPending
  const jobRunning = useJobRunningWithLinger(jobActive)
  const { keyboardJog, setKeyboardJog, activeKeys } = useKeyboardJog(continuous, canJog, xyFeed, zFeed)
  const zSteps = linearBarSteps(units)
  const xyFeedMax = controllerSettings.maxRateX != null && controllerSettings.maxRateY != null
    ? Math.min(controllerSettings.maxRateX, controllerSettings.maxRateY)
    : controllerSettings.maxRateX ?? controllerSettings.maxRateY
  const zFeedMax = controllerSettings.maxRateZ
  const spindleMin = controllerSettings.spindleMin ?? 0
  const spindleMax = controllerSettings.spindleMax
  const linearFeedPresetValues = linearFeedPresets(units)
  const xyFeedPresetValues = buildLimitedFeedPresets(linearFeedPresetValues, xyFeedMax)
  const zFeedPresetValues = buildLimitedFeedPresets(linearFeedPresetValues, zFeedMax)
  const spindlePresetValues = buildSpindlePresets(spindleMin, spindleMax)
  const controllerSpindleActive = status.spindleRunning ?? status.spindle > 0
  const spindleActive = spindleOverrideState === 'off'
    ? false
    : spindleOverrideState === 'on'
      ? true
      : controllerSpindleActive
  const linearFeedFormatter = useCallback(
    (value: number) => formatDisplayNumber(mmToDisplay(value, units), 0),
    [units],
  )
  const rotaryFeedFormatter = useCallback(
    (value: number) => formatDisplayNumber(value, 0),
    [],
  )

  useEffect(() => { localStorage.setItem('jog.xyFeed', JSON.stringify(xyFeed)) }, [xyFeed])
  useEffect(() => { localStorage.setItem('jog.zFeed', JSON.stringify(zFeed)) }, [zFeed])
  useEffect(() => { localStorage.setItem('jog.abcFeed', JSON.stringify(abcFeed)) }, [abcFeed])

  useEffect(() => {
    if (prevUnitsRef.current === units) return
    const presets = linearFeedPresets(units)
    setXyFeed((prev: number) => snapToNearestPreset(prev, presets))
    setZFeed((prev: number) => snapToNearestPreset(prev, presets))
    prevUnitsRef.current = units
  }, [units])

  useEffect(() => {
    if (xyFeedMax == null || !Number.isFinite(xyFeedMax) || xyFeedMax <= 0) return
    setXyFeed(prev => Math.min(prev, xyFeedMax))
  }, [xyFeedMax])

  useEffect(() => {
    if (zFeedMax == null || !Number.isFinite(zFeedMax) || zFeedMax <= 0) return
    setZFeed(prev => Math.min(prev, zFeedMax))
  }, [zFeedMax])

  useEffect(() => {
    if (spindleMax == null || !Number.isFinite(spindleMax) || spindleMax < spindleMin) return
    setSpindleTarget(prev => {
      if (prev === 24000 && spindleMax !== 24000) return spindleMax
      return clamp(prev, spindleMin, spindleMax)
    })
  }, [spindleMin, spindleMax])

  useEffect(() => {
    if (status.spindle <= 0) return
    setSpindleTarget(prev => {
      const next = spindleMax != null
        ? clamp(status.spindle, spindleMin, spindleMax)
        : Math.max(spindleMin, status.spindle)
      return prev === next ? prev : next
    })
    setSpindleOverrideState(null)
  }, [status.spindle, spindleMin, spindleMax])

  useEffect(() => {
    if (status.spindle <= 0 || status.spindleRunning === false) {
      setSpindleOverrideState(null)
    }
  }, [status.spindle, status.spindleRunning])

  useEffect(() => {
    if (status.state !== 'Jog') {
      setActiveStepJog(null)
    }
  }, [status.state, setActiveStepJog])

  return (
    <>
      {compact
        ? <TabletJogPad onSwitchStyle={() => {
            setCompact(false)
            localStorage.setItem('jog.desktopStyle', 'rose')
          }} />
        : !jobRunning && <div className="panel flex flex-col">
              <div className="panel-header flex items-center justify-between text-lg font-bold">
                <span>Jog</span>
                <div className="inline-flex rounded border border-border overflow-hidden">
                    <button className={`px-2 py-0.5 text-base font-bold transition-all ${
                      !continuous ? 'bg-accent/15 text-accent' : 'bg-transparent text-text-muted hover:text-text-primary'
                    }`} onClick={() => setContinuous(false)}>Step</button>
                    <button className={`px-2 py-0.5 text-base font-bold border-l border-border transition-all ${
                      continuous ? 'bg-accent/15 text-accent' : 'bg-transparent text-text-muted hover:text-text-primary'
                    }`} onClick={() => setContinuous(true)}>Continuous</button>
                    <button className="px-2 py-0.5 text-base font-bold border-l border-border transition-all bg-transparent text-text-muted hover:text-text-primary" onClick={() => {
                      setCompact(true)
                      localStorage.setItem('jog.desktopStyle', 'compact')
                    }}>Compact</button>
                  </div>
              </div>
              <div className="flex flex-col p-3 gap-3">

                <div className="relative flex items-center justify-center gap-3 shrink-0">
                  {continuous && (
                    <button
                      title={keyboardJog ? 'Keyboard jog ON — Arrows: X/Y · −/+: Z' : 'Enable keyboard jogging'}
                      onClick={() => setKeyboardJog(k => !k)}
                      className={`absolute top-0 left-0 flex items-center justify-center w-7 h-7 rounded border transition-all ${
                        keyboardJog
                          ? 'bg-accent/15 border-accent/50 text-accent'
                          : 'border-border text-text-muted hover:text-text-primary'
                      }`}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <rect x="1" y="3" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                        <rect x="3" y="5.5" width="2" height="2" rx="0.4"/>
                        <rect x="6.5" y="5.5" width="2" height="2" rx="0.4"/>
                        <rect x="10" y="5.5" width="2" height="2" rx="0.4"/>
                        <rect x="3" y="9" width="2" height="2" rx="0.4"/>
                        <rect x="6.5" y="9" width="3" height="2" rx="0.4"/>
                        <rect x="10" y="9" width="2" height="2" rx="0.4"/>
                      </svg>
                    </button>
                  )}
                  <JogRose xyFeed={xyFeed} continuous={continuous} disabled={!canJog}
                    isJogging={status.state === 'Jog'}
                    activeKeys={activeKeys} units={units} />
                  <AxisBar axis="Z" color="var(--info)" steps={zSteps} feed={zFeed}
                    continuous={continuous} disabled={!canJog} activeKeys={activeKeys} units={units} />
                  {(['A', 'B', 'C'] as const).slice(0, axes - 3).map((ax, i) => (
                    <AxisBar key={ax} axis={ax}
                      color={(['var(--accent)', 'var(--purple)', 'var(--teal)'] as const)[i]}
                      steps={ABC_STEPS} feed={abcFeed}
                      continuous={continuous} disabled={!canJog} units="mm" />
                  ))}
                </div>

                <div className="flex gap-2 items-center">
                  <FeedButton label="XY" value={xyFeed} presets={xyFeedPresetValues} onChange={setXyFeed}
                    formatValue={linearFeedFormatter} toDisplayValue={value => mmToDisplay(value, units)}
                    fromDisplayValue={value => displayToMm(value, units)} max={xyFeedMax} />
                  <FeedButton label="Z" value={zFeed} presets={zFeedPresetValues} onChange={setZFeed}
                    formatValue={linearFeedFormatter} toDisplayValue={value => mmToDisplay(value, units)}
                    fromDisplayValue={value => displayToMm(value, units)} max={zFeedMax} />
                  {axes > 3 && <FeedButton label="ABC" value={abcFeed} presets={MM_FEED_PRESETS} onChange={setAbcFeed} formatValue={rotaryFeedFormatter} />}
                  <span className="text-base text-text-dim shrink-0">
                    {axes > 3 ? `XYZ ${feedUnitLabel(units)}` : feedUnitLabel(units)}
                  </span>
                </div>

                <div className="text-center text-base text-text-dim leading-tight">
                  {continuous
                    ? keyboardJog
                      ? 'Arrows: X/Y · −/+: Z · Hold to jog'
                      : <>Hold to jog · <button className="underline hover:text-text-primary transition-colors" onClick={() => setKeyboardJog(true)}>enable keyboard</button></>
                    : ''
                  }
                </div>

              </div>
            </div>
  }

      <div className="panel flex flex-col">
        <div className="panel-header text-lg font-bold">Overrides</div>
        <div className="flex flex-col p-3 gap-2">
          <OverrideRow label="Feed" value={status.feedOverride}
            onMinus={() => sendRealtime(0x92)} onReset={() => sendRealtime(0x90)} onPlus={() => sendRealtime(0x91)} />
          <OverrideRow label="Rapid" value={status.rapidOverride} maxValue={100}
            onMinus={() => sendRealtime(status.rapidOverride >= 100 ? 0x96 : 0x97)}
            onReset={() => sendRealtime(0x95)}
            onPlus={() => sendRealtime(status.rapidOverride <= 25 ? 0x96 : 0x95)} />
        </div>
      </div>

      {spindleMax ? <div className="panel flex flex-col">
        <div className="panel-header">
          <span className='text-lg font-bold'>Spindle</span>
          {(() => {
            const actualRpm = Math.round(status.spindle * status.spindleOverride / 100)
            return (
              <div className={`ml-auto inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-base font-medium normal-case tracking-normal ${
                spindleActive
                  ? 'bg-ok/10 text-ok border border-ok/20'
                  : 'bg-elevated text-text-muted border border-border'
              }`}>
                {spindleActive && (
                  <div className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                )}
                {spindleActive ? `${actualRpm} RPM` : 'STOPPED'}
                {spindleActive && status.spindleOverride !== 100 && (
                  <span className="opacity-60">(cmd: {status.spindle})</span>
                )}
              </div>
            )
          })()}
        </div>
        <div className="flex flex-col p-3 gap-3">

          <div className="flex items-center gap-2">
            <span className="text-base text-text-muted font-medium shrink-0">RPM</span>
            <SpindleRpmInput
              value={spindleTarget}
              onChange={value => {
                setSpindleTarget(value)
                setSelectedSpindlePreset(null)
              }}
              className="input-field py-1.5 text-base font-mono text-right flex-1"
            />
          </div>

          <div className="grid grid-cols-4 gap-1">
            {spindlePresetValues.map(rpm => (
              <button
                key={rpm}
                onClick={() => {
                  setSpindleTarget(rpm)
                  setSelectedSpindlePreset(rpm)
                  if (spindleActive) {
                    if (sendRaw(`M3 S${rpm}`)) sendRealtime(0x99)
                  }
                }}
                className={`btn py-2 text-lg font-medium justify-center ${
                  selectedSpindlePreset === rpm
                    ? 'bg-accent/20 border-accent/60 text-accent'
                    : 'btn-ghost'
                }`}
              >
                {rpm >= 1000 ? `${rpm/1000}K` : rpm}
              </button>
            ))}
          </div>

          <OverrideRow label="Override" value={status.spindleOverride}
            onMinus={() => sendRealtime(0x9B)} onReset={() => sendRealtime(0x99)} onPlus={() => sendRealtime(0x9A)} />

          {spindleActive ? (
            <button
              onClick={() => {
                if (sendRaw('M5')) setSpindleOverrideState('off')
              }}
              className="btn w-full justify-center bg-danger/20 hover:bg-danger/30 text-danger border-danger/50"
            >
              <Square className="w-3.5 h-3.5 shrink-0 fill-current" />
              Stop Spindle
            </button>
          ) : (
            <button
              onClick={() => {
                if (sendRaw(`M3 S${spindleTarget}`)) setSpindleOverrideState('on')
              }}
              className="btn w-full gap-1.5 justify-center bg-ok/20 hover:bg-ok/30 text-ok border-ok/50"
            >
              <Play className="w-3.5 h-3.5 shrink-0 fill-current" />
              Start Spindle (CW)
            </button>
          )}

        </div>
      </div> : null}
    </>
  )
}

export function SpindlePanel({ className, isTablet }: { className?: string; isTablet?: boolean }) {
  const status = useMachineStore(s => s.status)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const spindleMin = controllerSettings.spindleMin ?? 0
  const spindleMax = controllerSettings.spindleMax

  const [spindleTarget, setSpindleTarget] = useState(24000)
  const [selectedSpindlePreset, setSelectedSpindlePreset] = useState<number | null>(null)
  const [spindleOverrideState, setSpindleOverrideState] = useState<'on' | 'off' | null>(null)

  const spindlePresetValues = buildSpindlePresets(spindleMin, spindleMax)
  const controllerSpindleActive = status.spindleRunning ?? status.spindle > 0

  const spindleActive = spindleOverrideState === 'off'
    ? false
    : spindleOverrideState === 'on'
      ? true
      : controllerSpindleActive

  useEffect(() => {
    if (spindleMax == null || !Number.isFinite(spindleMax) || spindleMax < spindleMin) return
    setSpindleTarget(prev => {
      if (prev === 24000 && spindleMax !== 24000) return spindleMax
      return clamp(prev, spindleMin, spindleMax)
    })
  }, [spindleMin, spindleMax])

  useEffect(() => {
    if (status.spindle <= 0) return
    setSpindleTarget(prev => {
      const next = spindleMax != null
        ? clamp(status.spindle, spindleMin, spindleMax)
        : Math.max(spindleMin, status.spindle)
      return prev === next ? prev : next
    })
    setSpindleOverrideState(null)
  }, [status.spindle, spindleMin, spindleMax])

  useEffect(() => {
    if (status.spindle <= 0 || status.spindleRunning === false) {
      setSpindleOverrideState(null)
    }
  }, [status.spindle, status.spindleRunning])

  return (
    <div className={`flex flex-col ${className ?? ''}`}>
      <div className="flex items-center justify-end px-4 py-2 border-b border-border bg-surface/80">
        {(() => {
          const actualRpm = Math.round(status.spindle * status.spindleOverride / 100)
          return (
            <div className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-base font-medium normal-case tracking-normal ${
              spindleActive
                ? 'bg-ok/10 text-ok border border-ok/20'
                : 'bg-elevated text-text-muted border border-border'
            }`}>
              {spindleActive && (
                <div className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
              )}
              {spindleActive ? `${actualRpm} RPM` : 'STOPPED'}
              {spindleActive && status.spindleOverride !== 100 && (
                <span className="opacity-60">(cmd: {status.spindle})</span>
              )}
            </div>
          )
        })()}
      </div>
      <div className={`flex flex-col p-3 ${isTablet ? 'gap-2' : 'gap-3'}`}>

          <div className="flex items-center gap-2">
            <span className={`${isTablet ? 'text-base' : 'text-base'} text-text-muted font-medium shrink-0`}>RPM</span>
            <SpindleRpmInput
              value={spindleTarget}
              onChange={value => {
                setSpindleTarget(value)
                setSelectedSpindlePreset(null)
              }}
              className={`input-field font-mono text-right flex-1 ${isTablet ? 'py-2 text-xl' : 'py-1.5 text-base'}`}
            />
          </div>

          <div className="grid grid-cols-4 gap-1">
            {spindlePresetValues.map(rpm => (
              <button
                key={rpm}
                onClick={() => {
                  setSpindleTarget(rpm)
                  setSelectedSpindlePreset(rpm)
                  if (spindleActive) {
                    if (sendRaw(`M3 S${rpm}`)) sendRealtime(0x99)
                  }
                }}
                className={`btn font-medium justify-center ${isTablet ? 'text-lg py-2' : 'text-base py-2'} ${
                  selectedSpindlePreset === rpm
                    ? 'bg-accent/20 border-accent/60 text-accent'
                    : 'btn-ghost'
                }`}
              >
                {rpm >= 1000 ? `${rpm/1000}K` : rpm}
              </button>
            ))}
          </div>

          <OverrideRow label="Override" value={status.spindleOverride} isTablet={isTablet}
            onMinus={() => sendRealtime(0x9B)} onReset={() => sendRealtime(0x99)} onPlus={() => sendRealtime(0x9A)} />

          {spindleActive ? (
            <button
              onClick={() => {
                if (sendRaw('M5')) setSpindleOverrideState('off')
              }}
              className={`btn w-full justify-center bg-danger/20 hover:bg-danger/30 text-danger border-danger/50 ${isTablet ? 'h-12 text-lg' : ''}`}
            >
              <Square className={`${isTablet ? 'w-4 h-4' : 'w-3.5 h-3.5'} shrink-0 fill-current`} />
              Stop Spindle
            </button>
          ) : (
            <button
              onClick={() => {
                if (sendRaw(`M3 S${spindleTarget}`)) setSpindleOverrideState('on')
              }}
              className={`btn w-full gap-1.5 justify-center bg-ok/20 hover:bg-ok/30 text-ok border-ok/50 ${isTablet ? 'h-12 text-lg' : ''}`}
            >
              <Play className={`${isTablet ? 'w-4 h-4' : 'w-3.5 h-3.5'} shrink-0 fill-current`} />
              Start Spindle (CW)
            </button>
          )}

        </div>
      </div>
  )
}

export function OverridesPanel({ className, isTablet }: { className?: string; isTablet?: boolean }) {
  const status = useMachineStore(s => s.status)
  return (
    <div className={`flex flex-col ${className ?? ''}`}>
      <div className="panel-header w-full flex items-center justify-between px-4 py-2 border-b border-border bg-surface/80 text-base uppercase tracking-wide">
        <span className="text-xl uppercase tracking-wide">Overrides</span>
      </div>
      <div className={`flex flex-col p-3 ${isTablet ? 'gap-3' : 'gap-2'}`}>
          <OverrideRow label="Feed" value={status.feedOverride} isTablet={isTablet}
            onMinus={() => sendRealtime(0x92)} onReset={() => sendRealtime(0x90)} onPlus={() => sendRealtime(0x91)} />
          <OverrideRow label="Rapid" value={status.rapidOverride} maxValue={100} isTablet={isTablet}
            onMinus={() => sendRealtime(status.rapidOverride >= 100 ? 0x96 : 0x97)}
            onReset={() => sendRealtime(0x95)}
            onPlus={() => sendRealtime(status.rapidOverride <= 25 ? 0x96 : 0x95)} />
        </div>
      </div>
  )
}

export function TabletJogPad({
  onSwitchStyle,
  layout = 'default',
}: {
  onSwitchStyle?: () => void
  layout?: 'default' | 'topBand'
} = {}) {
  const status = useMachineStore(s => s.status)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerJobStarting = useControllerJobStarting()
  const units = useMachineStore(s => s.units)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const topBand = layout === 'topBand'

  const [xyFeed, setXyFeed] = useState(() => loadPersistedJogFeed('jog.xyFeed', 1000))
  const [zFeed, setZFeed]   = useState(() => loadPersistedJogFeed('jog.zFeed', 200))
  const [continuous, setContinuous] = useState(false)
  const [stepSize, setStepSize] = useState(1)
  const [feedModal, setFeedModal] = useState<'xy' | 'z' | null>(null)
  const [customFeedValue, setCustomFeedValue] = useState('')
  const prevUnitsRef = useRef(units)

  const xyFeedMax = controllerSettings.maxRateX != null && controllerSettings.maxRateY != null
    ? Math.min(controllerSettings.maxRateX, controllerSettings.maxRateY)
    : controllerSettings.maxRateX ?? controllerSettings.maxRateY
  const zFeedMax = controllerSettings.maxRateZ
  const linearFeedPresetValues = linearFeedPresets(units)
  const xyFeedPresetValues = buildLimitedFeedPresets(linearFeedPresetValues, xyFeedMax)
  const zFeedPresetValues  = buildLimitedFeedPresets(linearFeedPresetValues, zFeedMax)

  useEffect(() => { localStorage.setItem('jog.xyFeed', JSON.stringify(xyFeed)) }, [xyFeed])
  useEffect(() => { localStorage.setItem('jog.zFeed',  JSON.stringify(zFeed))  }, [zFeed])

  useEffect(() => {
    if (prevUnitsRef.current === units) return
    const presets = linearFeedPresets(units)
    setXyFeed(prev => snapToNearestPreset(prev, presets))
    setZFeed(prev  => snapToNearestPreset(prev, presets))
    prevUnitsRef.current = units
  }, [units])

  useEffect(() => {
    if (xyFeedMax == null || !Number.isFinite(xyFeedMax) || xyFeedMax <= 0) return
    setXyFeed(prev => Math.min(prev, xyFeedMax))
  }, [xyFeedMax])

  useEffect(() => {
    if (zFeedMax == null || !Number.isFinite(zFeedMax) || zFeedMax <= 0) return
    setZFeed(prev => Math.min(prev, zFeedMax))
  }, [zFeedMax])

  const jobActive = status.state === 'Run' || status.state === 'Hold' || controllerJobStarting || controllerResetPending
  const canJog = (status.state === 'Idle' || status.state === 'Jog') && !controllerJobStarting && !controllerResetPending
  const jobRunning = useJobRunningWithLinger(jobActive)
  const jogDisabled = !canJog || jobRunning
  const { keyboardJog, setKeyboardJog } = useKeyboardJog(continuous, canJog, xyFeed, zFeed)
  const commandStepSize = displayToMm(stepSize, units)

  const { start: startYp, stop: stopYp } = useHoldJog('Y', 1, xyFeed, commandStepSize, continuous, jogDisabled)
  const { start: startYm, stop: stopYm } = useHoldJog('Y', -1, xyFeed, commandStepSize, continuous, jogDisabled)
  const { start: startXp, stop: stopXp } = useHoldJog('X', 1, xyFeed, commandStepSize, continuous, jogDisabled)
  const { start: startXm, stop: stopXm } = useHoldJog('X', -1, xyFeed, commandStepSize, continuous, jogDisabled)
  const { start: startZp, stop: stopZp } = useHoldJog('Z', 1, zFeed, commandStepSize, continuous, jogDisabled)
  const { start: startZm, stop: stopZm } = useHoldJog('Z', -1, zFeed, commandStepSize, continuous, jogDisabled)

  const steps = units === 'in' ? [0.001, 0.01, 0.1, 1] : [0.1, 1, 10, 100]
  const stepBtnClass = topBand
    ? 'flex-1 px-1 py-2 font-bold text-sm transition-colors'
    : 'flex-1 px-2 sm:px-4 portrait:px-4 portrait:py-4 max-sm:portrait:py-2 font-bold text-base sm:text-lg portrait:text-xl max-sm:portrait:text-base transition-colors'
  const jogClusterClass = topBand ? 'jog-cluster jog-cluster--top-band' : 'jog-cluster jog-cluster--default'
  const jogAreaPadding = topBand ? 'p-1' : 'p-2 sm:p-3 portrait:p-3 landscape:p-4 max-sm:portrait:p-2'
  const jogPadRootClass = onSwitchStyle
    ? 'flex-none h-[440px]'
    : topBand
      ? 'h-full min-h-0'
      : 'flex-1 min-h-0'

  useEffect(() => {
    if (!steps.includes(stepSize)) setStepSize(steps[1])
  }, [units])

  function openFeedModal(axis: 'xy' | 'z') {
    const current = axis === 'xy' ? xyFeed : zFeed
    setCustomFeedValue(String(mmToDisplay(current, units)))
    setFeedModal(axis)
  }

  function commitCustomFeed() {
    if (!feedModal) return
    const displayValue = Number(customFeedValue)
    if (!Number.isFinite(displayValue) || displayValue <= 0) return

    const max = feedModal === 'xy' ? xyFeedMax : zFeedMax
    const converted = displayToMm(displayValue, units)
    const next = max != null && Number.isFinite(max) ? Math.min(converted, max) : converted
    if (feedModal === 'xy') setXyFeed(next)
    else setZFeed(next)
    setFeedModal(null)
  }

  return (
    <>
    <div className={`panel flex flex-col portrait:flex-none portrait:min-h-[440px] ${jogPadRootClass}`}>
      <div className="panel-header flex flex-row items-stretch justify-between shrink-0 !p-0 border-b border-border overflow-hidden">
        <div className={`flex flex-col items-center justify-center border-r border-border shrink-0 gap-2 font-bold tracking-wider ${topBand ? 'w-12 py-1.5 text-sm' : 'w-16 py-3 text-lg'}`}>
          JOG
          {onSwitchStyle && (
            <button
              onClick={onSwitchStyle}
              title="Switch to rose view"
              className="text-text-muted hover:text-accent transition-colors"
            >
              <ArrowLeft size={16} />
            </button>
          )}
        </div>
        <div className="flex flex-1 items-stretch divide-x divide-border bg-surface">
          {steps.map(s => (
            <button
              key={s}
              className={`${stepBtnClass} ${!continuous && stepSize === s ? 'bg-accent text-white shadow-inner' : 'bg-transparent text-text-primary hover:bg-elevated'}`}
              onClick={() => { setContinuous(false); setStepSize(s); }}
            >
              {s}
            </button>
          ))}
          <button
            className={`${stepBtnClass} ${continuous ? 'bg-accent text-white shadow-inner' : 'bg-transparent text-text-primary hover:bg-elevated'}`}
            onClick={() => setContinuous(true)}
          >
            Cont
          </button>
        </div>
      </div>

      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">

        <div className={`flex flex-col border-r border-border shrink-0 ${topBand ? 'w-12 py-1' : 'w-16 max-sm:w-12 py-2'}`}>
          <button
            onClick={() => openFeedModal('xy')}
            className={`flex flex-col items-center justify-center flex-1 rounded-lg hover:bg-accent/5 transition-all group ${topBand ? 'gap-1 mx-0.5' : 'gap-3 mx-1'}`}
          >
            <span className={`font-extrabold text-text-muted tracking-wider leading-none ${topBand ? 'text-sm' : 'text-xl'}`}>XY</span>
            <div className="flex items-center">
              <span
                className={`font-mono font-semibold text-text-primary leading-none ${topBand ? 'text-base' : 'text-2xl'}`}
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                {formatDisplayNumber(mmToDisplay(xyFeed, units), 0)}
              </span>
              <span
                className={`text-text-dim leading-none ${topBand ? 'text-xs' : 'text-xl'}`}
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >{feedUnitLabel(units)}</span>
            </div>
          </button>
          <div className={`h-px bg-border shrink-0 ${topBand ? 'mx-1' : 'mx-2'}`} />
          <button
            onClick={() => openFeedModal('z')}
            className={`flex flex-col items-center justify-center flex-1 rounded-lg hover:bg-accent/5 transition-all group ${topBand ? 'gap-1 mx-0.5' : 'gap-3 mx-1'}`}
          >
            <span className={`font-extrabold text-text-muted tracking-wider leading-none ${topBand ? 'text-sm' : 'text-xl'}`}>Z</span>
            <div className="flex items-center">
              <span
                className={`font-mono font-semibold text-text-primary leading-none ${topBand ? 'text-base' : 'text-2xl'}`}
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                {formatDisplayNumber(mmToDisplay(zFeed, units), 0)}
              </span>
              <span
                className={`text-text-dim leading-none ${topBand ? 'text-xs' : 'text-xl'}`}
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >{feedUnitLabel(units)}</span>
            </div>
          </button>
        </div>

        {/* Jog controls */}
        <div
          {...noContextMenu}
          className={`jog-controls-area relative flex-1 min-h-0 flex justify-center items-center overflow-hidden ${jogAreaPadding} ${jogDisabled ? 'opacity-40 pointer-events-none' : ''}`}
        >
          {onSwitchStyle && continuous && (
            <button
              title={keyboardJog ? 'Keyboard jog ON — Arrows: X/Y · −/+: Z' : 'Enable keyboard jogging'}
              onClick={() => setKeyboardJog(k => !k)}
              className={`absolute left-2 top-2 z-10 flex items-center justify-center w-8 h-8 rounded border transition-all ${
                keyboardJog
                  ? 'bg-accent/15 border-accent/50 text-accent'
                  : 'border-border bg-surface/90 text-text-muted hover:text-text-primary'
              }`}
              disabled={jogDisabled}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <rect x="1" y="3" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                <rect x="3" y="5.5" width="2" height="2" rx="0.4"/>
                <rect x="6.5" y="5.5" width="2" height="2" rx="0.4"/>
                <rect x="10" y="5.5" width="2" height="2" rx="0.4"/>
                <rect x="3" y="9" width="2" height="2" rx="0.4"/>
                <rect x="6.5" y="9" width="3" height="2" rx="0.4"/>
                <rect x="10" y="9" width="2" height="2" rx="0.4"/>
              </svg>
            </button>
          )}
          <div className={jogClusterClass}>
            <div aria-hidden="true" />
            <button {...tabletJogPointerHandlers(startYp, stopYp)} className="jog-cluster-btn text-ok">Y+</button>
            <div aria-hidden="true" />
            <button {...tabletJogPointerHandlers(startZp, stopZp)} className="jog-cluster-btn text-info">Z+</button>
            <button {...tabletJogPointerHandlers(startXm, stopXm)} className="jog-cluster-btn text-danger">X-</button>
            <button onClick={() => sendRealtime(0x85)} className="jog-cluster-stop" aria-label="Stop jog">
              <Square className="jog-cluster-stop-icon" />
            </button>
            <button {...tabletJogPointerHandlers(startXp, stopXp)} className="jog-cluster-btn text-danger">X+</button>
            <div aria-hidden="true" />
            <div aria-hidden="true" />
            <button {...tabletJogPointerHandlers(startYm, stopYm)} className="jog-cluster-btn text-ok">Y-</button>
            <div aria-hidden="true" />
            <button {...tabletJogPointerHandlers(startZm, stopZm)} className="jog-cluster-btn text-info">Z-</button>
          </div>
        </div>

      </div>
    </div>

    {/* Feed preset modal */}
    {feedModal && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={() => setFeedModal(null)}
      >
        <div
          className="bg-surface border border-border rounded-2xl shadow-2xl p-8 w-[min(480px,calc(100vw-2rem))]"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-6">
            <span className="text-3xl font-bold">
              {feedModal === 'xy' ? 'XY' : 'Z'} Feedrate
            </span>
            <span className="text-2xl text-text-muted font-mono">{feedUnitLabel(units)}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(feedModal === 'xy' ? xyFeedPresetValues : zFeedPresetValues).map(preset => {
              const active = preset === (feedModal === 'xy' ? xyFeed : zFeed)
              return (
                <button
                  key={preset}
                  onClick={() => {
                    if (feedModal === 'xy') setXyFeed(preset)
                    else setZFeed(preset)
                    setFeedModal(null)
                  }}
                  className={`btn py-6 text-3xl font-mono justify-center ${
                    active
                      ? 'bg-accent/20 border-accent/60 text-accent'
                      : 'btn-ghost'
                  }`}
                >
                  {formatDisplayNumber(mmToDisplay(preset, units), 0)}
                </button>
              )
            })}
          </div>
          <div className="mt-5 pt-5 border-t border-border">
            <label className="block text-xl text-text-muted mb-2">Custom</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                value={customFeedValue}
                onChange={e => setCustomFeedValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitCustomFeed()
                  if (e.key === 'Escape') setFeedModal(null)
                }}
                min={0}
                step="any"
                className="input-field min-w-0 flex-1 py-3 px-4 text-2xl font-mono text-right"
              />
              <button
                className="btn btn-primary px-5 py-3 text-xl"
                onClick={commitCustomFeed}
                disabled={!Number.isFinite(Number(customFeedValue)) || Number(customFeedValue) <= 0}
              >
                Set
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
