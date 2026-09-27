import { Sun, Moon, Wifi, WifiOff, Settings, Maximize, Minimize, HelpCircle, Play, Square, RotateCcw, Zap, Power, Home, Target, Crosshair, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Lightbulb, LayoutDashboard, type LucideIcon } from 'lucide-react'
import fluidncLogo from '../assets/fluidnc-logo.svg'
import { useMachineStore, stateColor, stateBg } from '../store'
import { useGCodeStore } from '../store/gcode'
import { useJobRuntimeEstimate } from '../lib/jobRuntime'
import { useControllerJobStarting } from '../lib/jobState'
import { sendRealtime } from '../lib/ws'
import { alarmClearActionTitle, clearMachineAlarm } from '../lib/alarm'
import { runMacro, MACRO_BTN_CLASS } from '../lib/macros'
import { useState, useEffect, useMemo } from 'react'

const HEADER_ICON_MAP: Record<string, LucideIcon> = {
  play: Play, stop: Square, restart: RotateCcw, zap: Zap, power: Power,
  settings: Settings, home: Home, target: Target, crosshair: Crosshair,
  left: ArrowLeft, up: ArrowUp, right: ArrowRight, down: ArrowDown, lightbulb: Lightbulb,
}

interface Props {
  onSettingsClick: () => void
  onAboutClick: () => void
  isTablet?: boolean
  sticky?: boolean
}

export function Header({ onSettingsClick, onAboutClick, isTablet, sticky }: Props) {
  const connected = useMachineStore(s => s.connected)
  const status = useMachineStore(s => s.status)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerJobStarting = useControllerJobStarting()
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const theme = useMachineStore(s => s.theme)
  const toggleTheme = useMachineStore(s => s.toggleTheme)
  const pendingUpdateVersion = useMachineStore(s => s.pendingUpdateVersion)
  const macros = useMachineStore(s => s.macros)
  const model = useGCodeStore(s => s.model)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const fileName = useGCodeStore(s => s.fileName)
  const runtime = useJobRuntimeEstimate(status, model, controllerSettings, loadedPath, fileName)
  const showHeaderProgress = status.sdFilename && runtime.source === 'estimated' && runtime.progressPercent != null
  const headerProgressPercent = runtime.progressPercent ?? 0
  const pinnedMacros = useMemo(() => macros.filter(m => m.pinned), [macros])
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  function handleSoftReset() {
    if (confirm('Send soft reset (Ctrl+X)?')) sendRealtime(0x18)
  }

  return (
    <header className={`h-12 bg-surface border-b border-border flex items-center px-3 xl:px-4 gap-2 xl:gap-4 shrink-0 overflow-x-auto ${sticky ? 'sticky top-0 z-50' : ''}`}>
      <div className="flex items-center gap-2 shrink-0">
        <img src={fluidncLogo} alt="FluidNC" className="h-8 w-auto shrink-0" style={theme !== 'light' ? { filter: 'invert(1) hue-rotate(180deg)' } : undefined} />
      </div>

      <div className="h-5 w-px bg-border" />

      {status.state === 'Alarm' && !controllerResetPending ? (
        <button
          className={`tag ${stateBg(status.state)} ${stateColor(status.state)} cursor-pointer hover:opacity-80 active:opacity-60 text-base`}
          onClick={() => clearMachineAlarm(status.alarmCode)}
          title={alarmClearActionTitle(status.alarmCode)}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current text-base" />
          {status.state}
        </button>
      ) : (
        <div className={`tag ${stateBg(controllerJobStarting || controllerResetPending ? 'Run' : status.state)} ${stateColor(controllerJobStarting || controllerResetPending ? 'Run' : status.state)} text-base`}>
          <span className={`w-1.5 h-1.5 rounded-full ${
            controllerJobStarting || controllerResetPending || status.state === 'Run' || status.state === 'Jog' ? 'bg-current animate-pulse' : 'bg-current'
          }`} />
          {controllerResetPending ? 'Resetting' : controllerJobStarting ? 'Starting' : status.state}
        </div>
      )}

      {status.sdFilename && (
        <div className="hidden lg:flex items-center gap-2 text-sm text-text-muted min-w-0">
          {showHeaderProgress && (
            <>
              <div className="w-24 h-1 bg-elevated rounded-full overflow-hidden shrink-0">
                <div
                  className="h-full bg-info transition-all"
                  style={{ width: `${headerProgressPercent}%` }}
                />
              </div>
              <span className="w-9 text-right font-mono tabular-nums shrink-0">
                {Math.round(headerProgressPercent)}%
              </span>
            </>
          )}
          <span className="text-text-dim truncate max-w-32">{status.sdFilename}</span>
        </div>
      )}

      {pinnedMacros.length > 0 && (
        <>
          <div className="h-5 w-px bg-border shrink-0" />
          <div className="flex items-center gap-1 shrink-0">
            {pinnedMacros.map(m => {
              const Icon = m.glyph ? HEADER_ICON_MAP[m.glyph.toLowerCase()] : undefined
              return (
                <button
                  key={m.id}
                  className={`btn ${MACRO_BTN_CLASS[m.color]} flex items-center gap-1.5 px-2 py-1 ${
                    isTablet ? 'h-8 text-base' : 'h-7 text-sm'
                  } shrink-0`}
                  onClick={() => runMacro(m)}
                  title={m.label}
                >
                  {Icon && <Icon size={isTablet ? 14 : 12} />}
                  <span className="max-w-[72px] truncate">{m.label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        {connected ? (
          <div className={`flex items-center gap-1 text-base text-ok mr-2`}>
            <Wifi size={isTablet ? 18 : 14} />
            <span className="hidden sm:inline">Connected</span>
          </div>
        ) : (
          <div className={`flex items-center gap-1 ${isTablet ? 'text-base' : 'text-sm'} text-text-muted mr-2`}>
            <WifiOff size={isTablet ? 18 : 14} />
          </div>
        )}

        <button
          className={`btn-ghost ${isTablet ? 'px-3 py-2' : 'px-2 py-1.5'} text-base`}
          onClick={handleSoftReset}
          title="Soft Reset"
        >
          RST
        </button>

        <button
          className={`btn-ghost ${isTablet ? 'px-3 py-2' : 'px-2 py-1.5'}`}
          onClick={toggleTheme}
          title="Toggle theme"
        >
          {theme !== 'light' ? <Sun size={isTablet ? 18 : 14} /> : <Moon size={isTablet ? 18 : 14} />}
        </button>

        <button
          className={`hidden md:inline-flex btn-ghost ${isTablet ? 'px-3 py-2' : 'px-2 py-1.5'}`}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>

        {!isTablet && (
          <button
            className="hidden md:inline-flex btn-ghost px-2 py-1.5"
            onClick={() => window.dispatchEvent(new CustomEvent('reset-layout'))}
            title="Reset layout to default"
          >
            <LayoutDashboard size={18} />
          </button>
        )}

        <button
          className={`btn-ghost relative ${isTablet ? 'px-3 py-2' : 'px-2 py-1.5'}`}
          onClick={onAboutClick}
          title={pendingUpdateVersion ? `FigUI v${pendingUpdateVersion} available` : 'About'}
        >
          <HelpCircle size={18} />
          {pendingUpdateVersion && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent" />
          )}
        </button>

        <button
          className={`btn-ghost ${isTablet ? 'px-3 py-2' : 'px-2 py-1.5'}`}
          onClick={onSettingsClick}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  )
}
