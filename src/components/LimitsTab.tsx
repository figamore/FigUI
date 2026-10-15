import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useMachineStore } from '../store'
import {
  isSocketOpen,
  onLine,
  resumeBackgroundTraffic,
  sendRaw,
  suspendBackgroundTraffic,
} from '../lib/ws'
import { parseLimitSnapshotLine } from '../lib/fluidncReports'
import { useControllerJobStarting } from '../lib/jobState'
import { useGCodeSenderStore } from '../store/gcodeSender'

const AXIS_ORDER = ['x', 'y', 'z', 'a', 'b', 'c', 'u', 'v', 'w']

interface SettingValue {
  P: string
  V: string
}

interface Props {
  settings: SettingValue[]
}

interface LimitSnapshot {
  homingAxes: string[]
  limitAxes: string[]
  positive: string[]
  negative: string[]
  probe: boolean
  toolsetter: boolean
  samples: number
}

interface ConfiguredLimit {
  axis: string
  direction: 'positive' | 'negative'
  motor: number
  pin: string
}

type TileState = {
  key: string
  label: string
  active: boolean
  detail?: string
}

const EMPTY_SNAPSHOT: LimitSnapshot = {
  homingAxes: [],
  limitAxes: [],
  positive: [],
  negative: [],
  probe: false,
  toolsetter: false,
  samples: 0,
}

function axisSort(a: string, b: string): number {
  const ai = AXIS_ORDER.indexOf(a)
  const bi = AXIS_ORDER.indexOf(b)
  if (ai === -1 && bi === -1) return a.localeCompare(b)
  if (ai === -1) return 1
  if (bi === -1) return -1
  return ai - bi
}

function parseAxes(value: string): string[] {
  return [...new Set((value.match(/[a-z]/gi) ?? []).map(axis => axis.toLowerCase()))]
    .sort(axisSort)
}

function parseConfiguredLimits(settings: SettingValue[]): ConfiguredLimit[] {
  const limits: ConfiguredLimit[] = []

  for (const setting of settings) {
    const path = setting.P.replace(/^\/+/, '')
    const match = path.match(/^axes\/([a-z])\/(?:motor(\d+)\/)?limit_(pos|neg)_pin$/i)
    if (!match) continue

    const pin = setting.V.trim()
    if (!pin || /^(no_pin|null|none|off)$/i.test(pin)) continue

    limits.push({
      axis: match[1].toLowerCase(),
      direction: match[3].toLowerCase() === 'pos' ? 'positive' : 'negative',
      motor: Number(match[2] ?? 0),
      pin,
    })
  }

  return limits.sort((a, b) =>
    axisSort(a.axis, b.axis) ||
    a.direction.localeCompare(b.direction) ||
    a.motor - b.motor
  )
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function hasActiveAxis(activeLetters: string[], axis: string): boolean {
  return activeLetters.some(letter => letter.toLowerCase() === axis)
}

function configuredPinDetail(inputs: ConfiguredLimit[]): string | undefined {
  if (inputs.length === 0) return undefined
  return inputs
    .map(input => `Motor ${input.motor}: ${input.pin}`)
    .join('\n')
}

function LimitTile({ active, label, detail }: {
  active: boolean
  label: string
  detail?: string
}) {
  return (
    <div
      className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded border px-3 py-3 text-center transition-colors ${
        active
          ? 'border-ok/60 bg-ok/15 text-ok shadow-[inset_0_0_0_1px_rgb(var(--ok-rgb)/0.15)]'
          : 'border-border bg-elevated/35 text-text-muted'
      }`}
      title={detail ? `${label}\n${detail}` : label}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${
        active
          ? 'bg-ok shadow-[0_0_10px_rgb(var(--ok-rgb)/0.8)]'
          : 'bg-text-dim/40'
      }`} />
      <span className="text-xl font-bold leading-none tracking-normal">
        {label}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-75">
        {active ? 'Active' : 'Inactive'}
      </span>
    </div>
  )
}

export function LimitsTab({ settings }: Props) {
  const connected = useMachineStore(state => state.connected)
  // FluidNC refuses $limits during a job, and the '!' that ends the monitor
  // would then pause the job instead. A streamed job can report Idle between
  // moves, so the sender phase is checked too.
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const controllerJobStarting = useControllerJobStarting()
  const machineIdle = useMachineStore(state =>
    (state.status.state === 'Idle' || state.status.state === 'Alarm') && !state.status.sdFilename
  ) && senderPhase !== 'streaming' && senderPhase !== 'paused' && senderPhase !== 'draining' && !controllerJobStarting
  const [snapshot, setSnapshot] = useState<LimitSnapshot>(EMPTY_SNAPSHOT)
  const [phase, setPhase] = useState<'starting' | 'live' | 'error'>('starting')
  const [error, setError] = useState('')
  const [session, setSession] = useState(0)
  const headerSeenRef = useRef(false)
  const recognizedResponseRef = useRef(false)

  const configuredLimits = useMemo(() => parseConfiguredLimits(settings), [settings])

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT)
    setPhase('starting')
    setError('')
    headerSeenRef.current = false
    recognizedResponseRef.current = false

    if (!connected) {
      setPhase('error')
      setError('The controller is not connected.')
      return
    }

    if (!machineIdle) {
      setPhase('error')
      setError('The limit monitor is available when the machine is idle.')
      return
    }

    suspendBackgroundTraffic()
    let limitsSent = false
    let replyTimedOut = false

    const markLive = () => {
      recognizedResponseRef.current = true
      setPhase('live')
      setError('')
    }

    const unsubscribe = onLine(line => {
      if (line.startsWith('Homing Axes')) {
        markLive()
        const axes = parseAxes(line.slice(line.indexOf(':') + 1))
        setSnapshot(current => sameStrings(current.homingAxes, axes)
          ? current
          : { ...current, homingAxes: axes })
        return
      }

      if (line.startsWith('Limit Axes')) {
        markLive()
        const axes = parseAxes(line.slice(line.indexOf(':') + 1))
        setSnapshot(current => sameStrings(current.limitAxes, axes)
          ? current
          : { ...current, limitAxes: axes })
        return
      }

      if (line.includes('PosLimitPins') && line.includes('NegLimitPins')) {
        headerSeenRef.current = true
        markLive()
        return
      }

      if (!headerSeenRef.current || !line.startsWith(':')) return

      const next = parseLimitSnapshotLine(line)
      if (!next) return
      markLive()
      setSnapshot(current => {
        if (
          sameStrings(current.positive, next.positive) &&
          sameStrings(current.negative, next.negative) &&
          current.probe === next.probe &&
          current.toolsetter === next.toolsetter
        ) {
          return current.samples > 0 ? current : { ...current, samples: 1 }
        }
        return { ...current, ...next, samples: current.samples + 1 }
      })
    })

    limitsSent = isSocketOpen() && sendRaw('$limits')
    if (!limitsSent) {
      setPhase('error')
      setError('Could not start the limit monitor.')
    }

    const responseTimeout = window.setTimeout(() => {
      if (recognizedResponseRef.current) return
      replyTimedOut = true
      setPhase('error')
      setError('FluidNC did not respond to $limits. The machine may need to be idle.')
    }, 5000)

    return () => {
      window.clearTimeout(responseTimeout)
      unsubscribe()
      // '!' ends the monitor loop. Send it only when the loop may be running:
      // $limits was sent and either answered or still within its reply window.
      const exitNeeded = limitsSent && (recognizedResponseRef.current || !replyTimedOut)
      const exitQueued = exitNeeded && isSocketOpen() ? sendRaw('!') : false
      window.setTimeout(resumeBackgroundTraffic, exitQueued ? 150 : 0)
    }
  }, [connected, machineIdle, session])

  const axes = useMemo(() => {
    const found = new Set<string>()
    configuredLimits.forEach(input => found.add(input.axis))
    snapshot.homingAxes.forEach(axis => found.add(axis))
    snapshot.limitAxes.forEach(axis => found.add(axis))
    snapshot.positive.forEach(axis => found.add(axis.toLowerCase()))
    snapshot.negative.forEach(axis => found.add(axis.toLowerCase()))
    return [...found].sort(axisSort)
  }, [configuredLimits, snapshot])

  const limitTilePairs = useMemo<TileState[][]>(() => axes.map(axis => {
    const negativeInputs = configuredLimits.filter(input =>
      input.axis === axis && input.direction === 'negative'
    )
    const positiveInputs = configuredLimits.filter(input =>
      input.axis === axis && input.direction === 'positive'
    )
    const upperAxis = axis.toUpperCase()

    return [
      {
        key: `${axis}-negative`,
        label: `${upperAxis}-`,
        active: hasActiveAxis(snapshot.negative, axis),
        detail: configuredPinDetail(negativeInputs),
      },
      {
        key: `${axis}-positive`,
        label: `${upperAxis}+`,
        active: hasActiveAxis(snapshot.positive, axis),
        detail: configuredPinDetail(positiveInputs),
      },
    ]
  }), [axes, configuredLimits, snapshot.negative, snapshot.positive])

  const activeCount =
    limitTilePairs.flat().filter(tile => tile.active).length +
    Number(snapshot.probe) +
    Number(snapshot.toolsetter)

  return (
    <div className="min-h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-elevated/20">
        <span className={`h-2 w-2 rounded-full shrink-0 ${
          phase === 'live'
            ? 'bg-ok shadow-[0_0_8px_rgb(var(--ok-rgb)/0.7)]'
            : phase === 'starting' ? 'bg-warn animate-pulse' : 'bg-danger'
        }`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">
            {phase === 'live' ? 'Live input monitor' : phase === 'starting' ? 'Starting monitor...' : 'Monitor unavailable'}
          </div>
          {phase === 'live' && (
            <div className="text-xs text-text-dim">
              {activeCount === 0 ? 'No inputs active' : `${activeCount} active input${activeCount === 1 ? '' : 's'}`}
            </div>
          )}
        </div>
        <button
          onClick={() => setSession(value => value + 1)}
          className="p-2 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors"
          title="Restart limit monitor"
        >
          <RefreshCw size={14} className={phase === 'starting' ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 m-4 p-3 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {phase !== 'error' && axes.length === 0 && (
        <div className="flex items-center justify-center h-32 text-sm text-text-dim">
          Waiting for configured axes...
        </div>
      )}

      {phase !== 'error' && limitTilePairs.length > 0 && (
        <div className="flex flex-col gap-3 p-5">
          {limitTilePairs.map(pair => (
            <div key={pair[0].key.split('-')[0]} className="grid grid-cols-2 gap-3">
              {pair.map(tile => (
                <LimitTile
                  key={tile.key}
                  active={tile.active}
                  label={tile.label}
                  detail={tile.detail}
                />
              ))}
            </div>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <LimitTile
              active={snapshot.probe}
              label="Probe"
            />
            <LimitTile
              active={snapshot.toolsetter}
              label="Toolsetter"
            />
          </div>
        </div>
      )}
    </div>
  )
}
