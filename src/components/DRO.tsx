import { useEffect, useRef, useState } from 'react'
import { ArrowRightToLine, Home, Power, Square, TriangleAlert } from 'lucide-react'
import { useMachineStore, activePosition } from '../store'
import { sendRaw, sendRealtime, sendSilentAlarmQuery } from '../lib/ws'
import { jogFeedKeyForAxis, loadPersistedJogFeed } from '../lib/jog'
import { clearMachineAlarm } from '../lib/alarm'
import { droFeedUnitLabel, formatAxisCoord, formatFeedRate } from '../lib/units'
import { useControllerJobStarting } from '../lib/jobState'
import { useManualAtcStore } from '../store/manualAtc'
import { useIsPortrait } from '../lib/viewport'

const ALARM_MESSAGES: Record<number, string> = {
  1: 'Hard limit triggered',
  2: 'Soft limit exceeded',
  3: 'Abort Cycle',
  4: 'Probe fail — initial state',
  5: 'Probe fail — no contact',
  6: 'Homing fail — reset',
  7: 'Homing fail — door open',
  8: 'Homing fail — pull-off',
  9: 'Homing fail — approach',
  10: 'Spindle control fault',
  11: 'Input Pin Initially On',
  12: 'Ambiguous Switch',
  13: 'Hard stop',
  14: 'Machine is unhomed',
  15: 'Initialization failure',
  16: 'Expander reset',
  17: 'G-code command error',
  18: 'Probe hard limit',
}

const AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'] as const

const AXIS_COLOR: Record<string, string> = {
  X: 'var(--danger)',
  Y: 'var(--ok)',
  Z: 'var(--info)',
  A: 'var(--accent)',
  B: 'var(--purple)',
  C: 'var(--teal)',
}

type PendingAxisAction = {
  kind: 'go-to-zero' | 'home'
  axis: string
}

const MOTION_STATES = new Set(['Jog', 'Hold', 'Home'])
const E_STOP_HIDE_DELAY_MS = 700
const HOME_ALL_ACTION_AXIS = 'all'
const WORK_ORIGINS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const

function useMotionControlLock(jobActive: boolean) {
  const [locked, setLocked] = useState(jobActive)

  useEffect(() => {
    if (jobActive) {
      setLocked(true)
      return
    }

    const timeoutId = window.setTimeout(() => setLocked(false), E_STOP_HIDE_DELAY_MS)
    return () => window.clearTimeout(timeoutId)
  }, [jobActive])

  return locked
}

export function DRO({
  isTablet = false,
  layout = 'default',
}: {
  isTablet?: boolean
  /** Fit beside Jog in short-height landscape without internal scroll. */
  layout?: 'default' | 'topBand'
}) {
  const status = useMachineStore(s => s.status)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerJobStarting = useControllerJobStarting()
  const positionMode = useMachineStore(s => s.positionMode)
  const setPositionMode = useMachineStore(s => s.setPositionMode)
  const axes = useMachineStore(s => s.axes)
  const units = useMachineStore(s => s.units)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const resetToolReference = useManualAtcStore(s => s.resetReference)
  const completeReferenceSetup = useManualAtcStore(s => s.completeReferenceSetup)
  const [pendingAxisAction, setPendingAxisAction] = useState<PendingAxisAction | null>(null)
  const [pendingAxisActionStarted, setPendingAxisActionStarted] = useState(false)
  const [workOriginOpen, setWorkOriginOpen] = useState(false)
  const workOriginRef = useRef<HTMLDivElement>(null)
  const pos = activePosition(status, positionMode)
  const isPortrait = useIsPortrait()
  const topBandLayout = layout === 'topBand'
  const tightLayout = topBandLayout
  const tabletBtnSize = isTablet && isPortrait
    ? 'w-20 h-20'
    : topBandLayout
      ? 'w-12 h-12'
      : isTablet
        ? 'w-14 h-14'
        : 'w-8 h-8'
  const tabletIconSize = isTablet && isPortrait ? 22 : topBandLayout ? 14 : isTablet ? 16 : 11
  const tabletHomeIconSize = isTablet && isPortrait ? 30 : topBandLayout ? 18 : isTablet ? 22 : 13
  const tabletCoordBothSize = topBandLayout
    ? 'text-[1.45rem]'
    : isTablet
      ? 'text-[2.25rem]'
      : 'text-[1.05rem]'
  const tabletCoordSingleSize = topBandLayout
    ? 'text-[1.75rem]'
    : isTablet
      ? 'text-[3rem]'
      : 'text-[1.75rem]'
  const tabletAxisLabelSize = topBandLayout ? 'text-xl' : isTablet ? 'text-2xl' : 'text-base'
  const tabletActionBtnClass = isTablet && isPortrait
    ? 'h-20 text-xl'
    : topBandLayout
      ? 'h-11 text-base'
      : isTablet
        ? 'h-14 text-lg'
        : 'h-7 text-base'
  const tabletStopBtnClass = isTablet && isPortrait
    ? 'h-20 text-xl'
    : topBandLayout
      ? 'h-11 text-sm'
      : isTablet
        ? 'h-14 text-lg'
        : 'h-7 text-sm'
  const tabletFooterTextSize = topBandLayout
    ? 'text-sm'
    : isTablet
      ? 'text-xl'
      : 'text-base'
  const activeWorkOrigin = WORK_ORIGINS.includes(status.gcodeModes?.wcs as (typeof WORK_ORIGINS)[number])
    ? status.gcodeModes?.wcs as (typeof WORK_ORIGINS)[number]
    : null

  const wCoords: Record<string, number> = {
    X: status.wpos.x, Y: status.wpos.y, Z: status.wpos.z,
    A: status.wpos.a ?? 0, B: status.wpos.b ?? 0, C: status.wpos.c ?? 0,
  }
  const mCoords: Record<string, number> = {
    X: status.mpos.x, Y: status.mpos.y, Z: status.mpos.z,
    A: status.mpos.a ?? 0, B: status.mpos.b ?? 0, C: status.mpos.c ?? 0,
  }
  const coordValues: Record<string, number> = {
    X: pos.x, Y: pos.y, Z: pos.z,
    A: pos.a ?? 0, B: pos.b ?? 0, C: pos.c ?? 0,
  }

  const visibleAxes = AXES.slice(0, axes)
  const isJobActive = useMotionControlLock(
    status.state === 'Run' || status.state === 'Hold' || controllerJobStarting || controllerResetPending,
  )
  const isHomeAllPending = pendingAxisAction?.kind === 'home' && pendingAxisAction.axis === HOME_ALL_ACTION_AXIS
  const shouldHideMotionControls = isJobActive && pendingAxisAction === null
  const areAxisButtonsDisabled = pendingAxisAction !== null

  // Auto-query alarm details when entering alarm state without a name
  useEffect(() => {
    if (status.state === 'Alarm' && !status.alarmName) {
      sendSilentAlarmQuery()
    }
  }, [status.state, status.alarmName])

  useEffect(() => {
    if (!pendingAxisAction) return

    if (!pendingAxisActionStarted) {
      if (MOTION_STATES.has(status.state)) {
        setPendingAxisActionStarted(true)
      }
      return
    }

    if (!MOTION_STATES.has(status.state)) {
      setPendingAxisAction(null)
      setPendingAxisActionStarted(false)
    }
  }, [pendingAxisAction, pendingAxisActionStarted, status.state])

  useEffect(() => {
    if (!pendingAxisAction || pendingAxisActionStarted) return

    const timeoutId = window.setTimeout(() => {
      setPendingAxisAction(current => current === pendingAxisAction ? null : current)
    }, 1500)

    return () => window.clearTimeout(timeoutId)
  }, [pendingAxisAction, pendingAxisActionStarted])

  useEffect(() => {
    if (!workOriginOpen) return

    function handleOutsideClick(event: MouseEvent) {
      if (workOriginRef.current && !workOriginRef.current.contains(event.target as Node)) {
        setWorkOriginOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [workOriginOpen])


  function setWorkZero(command: string, includesZ: boolean) {
    if (includesZ && hasManualATC && !resetToolReference()) return
    if (!sendRaw(command)) return
    if (includesZ && hasManualATC) completeReferenceSetup()
  }
  function zeroAxis(axis: string) { setWorkZero(`G10 L20 P0 ${axis}0`, axis === 'Z') }
  function zeroAll() { setWorkZero(`G10 L20 P0 ${visibleAxes.map(a => `${a}0`).join(' ')}`, visibleAxes.includes('Z')) }
  function goToZero(axis: string) {
    const [feedKey, fallbackFeed] = jogFeedKeyForAxis(axis)
    const feed = loadPersistedJogFeed(feedKey, fallbackFeed)
    setPendingAxisAction({ kind: 'go-to-zero', axis })
    setPendingAxisActionStarted(false)
    sendRaw(`$J=G90 G21 F${feed} ${axis}0`)
  }
  function homeAxis(axis: string) {
    setPendingAxisAction({ kind: 'home', axis })
    setPendingAxisActionStarted(false)
    sendRaw(`$H${axis}`)
  }
  function homeAll() {
    setPendingAxisAction({ kind: 'home', axis: HOME_ALL_ACTION_AXIS })
    setPendingAxisActionStarted(false)
    sendRaw('$H')
  }
  function cancelPendingAxisAction() {
    if (pendingAxisAction?.kind === 'go-to-zero') {
      sendRealtime(0x85)
      return
    }
    sendRealtime(0x18)
  }

  return (
    <div className={`panel flex flex-col ${topBandLayout ? 'h-full min-h-0 overflow-hidden' : ''}`}>
      <div className={`panel-header justify-between shrink-0 ${tightLayout ? 'flex-wrap gap-y-1 py-1.5' : ''}`}>
        <span className={`font-bold ${tightLayout ? 'text-base' : 'text-lg'}`}>Position</span>
        <div className={`flex items-center gap-1 ${tightLayout ? 'flex-wrap justify-end' : 'gap-1.5'}`}>
          <div className="flex items-center gap-0.5 bg-elevated rounded-sm border border-border p-0.5">
            {(['WPos', 'MPos'] as const).map(m => {
              const active = positionMode === m || positionMode === 'Both'
              return (
                <button
                  key={m}
                  onClick={() => {
                    if (m === 'WPos') {
                      if (positionMode === 'WPos') return
                      setPositionMode(positionMode === 'Both' ? 'MPos' : 'Both')
                    } else {
                      if (positionMode === 'MPos') return
                      setPositionMode(positionMode === 'Both' ? 'WPos' : 'Both')
                    }
                  }}
                  className={`${tightLayout ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-0.5 text-base'} rounded-sm transition-colors ${active
                    ? 'bg-surface border border-border text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  {m}
                </button>
              )
            })}
          </div>
          <div ref={workOriginRef} className="relative">
            <button
              onClick={() => setWorkOriginOpen(open => !open)}
              className={`flex items-center gap-1 ${tightLayout ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-1 text-base'} rounded-sm border transition-colors ${
                workOriginOpen
                  ? 'bg-accent/10 border-accent/50 text-accent'
                  : 'bg-elevated border-border text-text-primary hover:border-border-strong'
              }`}
              title="Select work origin"
            >
              <span className="font-mono">{activeWorkOrigin ?? 'WCS'}</span>
              <svg
                className={`w-3 h-3 transition-transform ${workOriginOpen ? 'rotate-180' : ''}`}
                viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
              >
                <path d="M2 4l4 4 4-4" />
              </svg>
            </button>
            {workOriginOpen && (
              <div className="absolute right-0 top-full mt-1 min-w-[5.5rem] overflow-hidden rounded-sm border border-border bg-surface shadow-lg z-20 py-1">
                {WORK_ORIGINS.map(origin => {
                  const isActive = origin === activeWorkOrigin
                  return (
                    <button
                      key={origin}
                      onClick={() => {
                        sendRaw(origin)
                        setWorkOriginOpen(false)
                      }}
                      className={`w-full px-3 py-1.5 text-left text-base font-mono transition-colors ${
                        isActive
                          ? 'bg-accent/10 text-accent font-semibold'
                          : 'text-text-primary hover:bg-elevated'
                      }`}
                    >
                      {origin}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Axis rows – compact */}
      <div className={`px-3 shrink-0 ${topBandLayout ? 'space-y-0 py-0.5' : 'space-y-0.5 py-2'}`}>
        {positionMode === 'Both' && (
          <div className="flex items-center gap-2 pb-0.5">
            <span className="w-4 shrink-0" />
            <div className="flex-1 grid grid-cols-2 gap-2 text-sm font-mono text-text-muted uppercase tracking-widest">
              <span className="text-right">W</span>
              <span className="text-right">M</span>
            </div>
            {!shouldHideMotionControls && <div className={`shrink-0 invisible ${tabletBtnSize}`} />}
            {!shouldHideMotionControls && (
              <div className={`shrink-0 invisible flex items-center justify-center gap-0.5 ${tabletBtnSize}`}>
                <ArrowRightToLine size={tabletIconSize} />
                <span className={`font-mono ${isTablet ? 'text-lg' : 'text-[11px]'}`}>0</span>
              </div>
            )}
            {!shouldHideMotionControls && <div className={`shrink-0 invisible ${tabletBtnSize}`} />}
          </div>
        )}
        {visibleAxes.map(ax => (
          <div key={ax} className={`flex items-center ${topBandLayout ? 'gap-1' : 'gap-2'}`}>
            <span
              className={`font-black uppercase tracking-widest w-4 shrink-0 select-none ${tabletAxisLabelSize}`}
              style={{ color: AXIS_COLOR[ax] ?? 'var(--text-muted)' }}
            >
              {ax}
            </span>
            {positionMode === 'Both' ? (
              <div className="flex-1 grid grid-cols-2 gap-2 min-w-0">
                <span
                  className={`text-right font-mono tabular-nums tracking-tight min-w-0 overflow-hidden ${tabletCoordBothSize}`}
                  style={{ fontWeight: 300, lineHeight: 1.2, color: 'var(--text-primary)' }}
                >
                  {formatAxisCoord(wCoords[ax], ax, units)}
                </span>
                <span
                  className={`text-right font-mono tabular-nums tracking-tight min-w-0 overflow-hidden ${tabletCoordBothSize}`}
                  style={{ fontWeight: 300, lineHeight: 1.2, color: 'var(--text-muted)' }}
                >
                  {formatAxisCoord(mCoords[ax], ax, units)}
                </span>
              </div>
            ) : (
              <span
                className={`flex-1 text-right font-mono tabular-nums tracking-tight ${tabletCoordSingleSize}`}
                style={{ fontWeight: 300, lineHeight: 1.2, color: 'var(--text-primary)' }}
              >
                {formatAxisCoord(coordValues[ax], ax, units)}
              </span>
            )}
            {!shouldHideMotionControls && (
              <button
                className={`shrink-0 flex items-center justify-center rounded-sm
                           border border-border text-text-muted font-bold
                           hover:text-accent hover:border-accent/50 hover:bg-accent/5
                           disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:text-text-muted disabled:hover:border-border disabled:hover:bg-transparent
                           transition-all duration-100 ${tabletBtnSize} ${isTablet ? 'text-xl' : 'text-base'}`}
                onClick={() => zeroAxis(ax)}
                title={`Zero ${ax}`}
                disabled={areAxisButtonsDisabled}
              >
                Z
              </button>
            )}
            {!shouldHideMotionControls && (
              pendingAxisAction?.axis === ax && pendingAxisAction.kind === 'go-to-zero' ? (
                <button
                  className={`shrink-0 flex items-center justify-center rounded-sm
                             border border-danger/50 text-danger bg-danger/10
                             hover:bg-danger/15 transition-all duration-100 ${tabletBtnSize}`}
                  onClick={cancelPendingAxisAction}
                  title={`Cancel ${ax} move`}
                >
                  <Square size={tabletIconSize} className="fill-current" />
                </button>
              ) : (
                <button
                  className={`shrink-0 flex items-center justify-center gap-0.5 rounded-sm
                             border border-border text-text-muted
                             hover:text-accent hover:border-accent/50 hover:bg-accent/5
                             disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:text-text-muted disabled:hover:border-border disabled:hover:bg-transparent
                             transition-all duration-100 ${tabletBtnSize}`}
                  onClick={() => goToZero(ax)}
                  title={`Go to ${ax} zero`}
                  disabled={areAxisButtonsDisabled}
                >
                  <ArrowRightToLine size={tabletIconSize} />
                  <span className={`font-mono ${isTablet ? 'text-lg' : 'text-[11px]'}`}>0</span>
                </button>
              )
            )}
            {!shouldHideMotionControls && (
              pendingAxisAction?.axis === ax && pendingAxisAction.kind === 'home' ? (
                <button
                  className={`shrink-0 flex items-center justify-center rounded-sm
                             border border-danger/50 text-danger bg-danger/10
                             hover:bg-danger/15 transition-all duration-100 ${tabletBtnSize}`}
                  onClick={cancelPendingAxisAction}
                  title={`Abort ${ax} homing`}
                >
                  <Square size={tabletIconSize} className="fill-current" />
                </button>
              ) : (
                <button
                  className={`shrink-0 flex items-center justify-center rounded-sm
                             border border-border text-text-muted
                             disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-transparent
                             hover:border-current hover:bg-current/5
                             transition-all duration-100 ${tabletBtnSize}`}
                  style={{ ['--tw-text-opacity' as string]: '1' } as React.CSSProperties}
                  onClick={() => homeAxis(ax)}
                  title={`Home ${ax}`}
                  disabled={areAxisButtonsDisabled}
                >
                  <Home size={tabletHomeIconSize} style={{ color: AXIS_COLOR[ax] ?? 'var(--text-muted)' }} />
                </button>
              )
            )}
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className={`border-t border-border px-3 flex gap-2 shrink-0 ${topBandLayout ? 'py-1' : 'py-2'}`}>
        {!shouldHideMotionControls && !isHomeAllPending && (
          <button
            className={`btn btn-warn flex-1 font-bold ${tabletActionBtnClass}`}
            onClick={zeroAll}
            title="Set current position as work zero for all axes"
            disabled={areAxisButtonsDisabled}
          >
            ⊙ Zero All
          </button>
        )}
        {!shouldHideMotionControls && !isHomeAllPending && (
          <button
            className={`btn btn-ghost flex-1 font-bold flex items-center justify-center gap-1.5 ${tabletActionBtnClass}`}
            onClick={homeAll}
            title="Home all axes"
            disabled={areAxisButtonsDisabled}
          >
            <Home size={isTablet && isPortrait ? 24 : topBandLayout ? 18 : isTablet ? 20 : 12} />
            Home All
          </button>
        )}
        {!shouldHideMotionControls && isHomeAllPending && (
          <button
            className={`btn btn-warn flex-1 font-bold flex items-center justify-center gap-1.5 ${tabletStopBtnClass}`}
            onClick={cancelPendingAxisAction}
            title="Abort homing (soft reset controller)"
          >
            <Square size={isTablet && isPortrait ? 24 : topBandLayout ? 18 : isTablet ? 20 : 12} className="fill-current" />
            Abort Homing
          </button>
        )}
        {shouldHideMotionControls && (
          <button
            className="btn flex-1 h-10 text-2xl font-bold flex items-center justify-center gap-1.5 bg-danger hover:bg-danger/85 text-white border-transparent"
            onClick={() => sendRealtime(0x18)}
            title="E-Stop — soft reset the controller"
          >
            <Power className='w-6 h-6' />
            E-Stop
          </button>
        )}
      </div>

      {status.state === 'Alarm' && (
        <div className='flex flex-col border-t-2 border-danger bg-danger/10 px-3 py-3 gap-3'>
          <div className="flex items-center gap-3">
            <TriangleAlert className="text-danger w-12 h-12" />
            <div className="flex flex-col gap-2 flex-1 min-w-0">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-2xl font-black text-danger uppercase tracking-widest leading-none">
                  Alarm
                </span>

                <span className="text-2xl font-semibold text-text-primary leading-snug">
                  {status.alarmName
                    ?? (status.alarmCode != null
                      ? (ALARM_MESSAGES[status.alarmCode] ?? `Unknown alarm code ${status.alarmCode}`)
                      : 'Machine is in alarm state')}
                </span>
              </div>
            </div>
          </div>
          <button
            className="btn btn-danger w-full h-8 text-2xl font-bold"
            onClick={() => clearMachineAlarm(status.alarmCode)}
          >
            Clear Alarm
          </button>
        </div>
      )}

      {/* Feed / Spindle readout */}
      <div className={`border-t border-border px-3 flex justify-between font-mono text-text-muted shrink-0 ${
        topBandLayout ? 'py-0.5' : isTablet ? 'py-2' : 'py-1'
      } ${tabletFooterTextSize}`}>
        <div className="flex items-center gap-1.5">
          <span>F</span>
          <span className="text-text-primary">{formatFeedRate(status.feed, units)}</span>
          <span className={`text-text-dim ${isTablet ? 'text-base' : 'text-sm'}`}>{droFeedUnitLabel(units)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span>S</span>
          <span className="text-text-primary">{status.spindle}</span>
          <span className={`text-text-dim ${isTablet ? 'text-base' : 'text-sm'}`}>rpm</span>
        </div>
      </div>

      {!topBandLayout && <GCodeModesRow isTablet={isTablet} />}
    </div>
  )
}

const MODE_TOOLTIPS: Record<string, string> = {
  G0: 'Rapid move', G1: 'Linear feed move', G2: 'Arc CW', G3: 'Arc CCW',
  'G38.2': 'Probe toward, error on fail', 'G38.3': 'Probe toward',
  'G38.4': 'Probe away, error on fail', 'G38.5': 'Probe away', G80: 'Motion cancel',
  G54: 'Work coord 1', G55: 'Work coord 2', G56: 'Work coord 3',
  G57: 'Work coord 4', G58: 'Work coord 5', G59: 'Work coord 6',
  'G59.1': 'Work coord 7', 'G59.2': 'Work coord 8', 'G59.3': 'Work coord 9',
  G17: 'XY plane', G18: 'XZ plane', G19: 'YZ plane',
  G20: 'Inches', G21: 'Millimeters',
  G90: 'Absolute distance', G91: 'Incremental distance',
  'G90.1': 'Absolute arc IJK', 'G91.1': 'Incremental arc IJK',
  G93: 'Inverse time feed', G94: 'Units per minute', G95: 'Units per revolution',
  G40: 'Cutter comp off', G41: 'Cutter comp left', G42: 'Cutter comp right',
  'G43.1': 'Tool length applied', G49: 'Tool length cancel',
  M0: 'Program pause', M1: 'Optional pause', M2: 'Program end', M30: 'Program end + rewind',
  M3: 'Spindle CW', M4: 'Spindle CCW', M5: 'Spindle off',
  M7: 'Mist coolant', M8: 'Flood coolant', M9: 'Coolant off',
}

function GCodeModesRow({ isTablet }: { isTablet: boolean }) {
  const modes = useMachineStore(s => s.status.gcodeModes)
  if (!modes) return null

  const order: Array<keyof typeof modes> = [
    'motion', 'wcs', 'units', 'distance', 'feedRateMode', 'plane',
    'arcDistance', 'cutterComp', 'toolLength', 'spindle', 'programState',
  ]
  const items = order
    .map(k => modes[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)

  if (items.length === 0) return null

  const textSize = isTablet ? 'text-xl' : 'text-base'

  return (
    <div className={`border-t border-border px-3 py-2 flex flex-wrap gap-1 font-mono select-none cursor-default ${textSize}`}>
      {items.map(word => (
        <span
          key={word}
          title={MODE_TOOLTIPS[word] ?? word}
          className="px-1.5 py-0.5 rounded-sm bg-elevated border border-border text-text-primary"
        >
          {word}
        </span>
      ))}
      {modes.tool != null && (
        <span
          title="Active tool"
          className="px-1.5 py-0.5 rounded-sm bg-elevated border border-border text-text-muted"
        >
          T{modes.tool}
        </span>
      )}
    </div>
  )
}
