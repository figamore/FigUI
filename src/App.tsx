import { useCallback, useEffect, useRef, useState } from 'react'
import { useMachineStore } from './store'
import { useGCodeStore } from './store/gcode'
import { useGCodeSenderStore } from './store/gcodeSender'
import { useTerminalStore } from './store/terminal'
import { connect, isSocketOpen, onLine, onSoftReset, sendStartupQueries } from './lib/ws'
import { setBase, getBase, getDeviceInfo, getDeviceInfoFast, loadMacroCfg, WebUIBlockedError } from './lib/http'
import { isWasmBridgeActive, WASM_BRIDGE_BASE } from './wasmBridge/shimTransport'
import { parseESP800 } from './lib/parser'
import { loadControllerConfigSettings } from './lib/controllerConfig'
import { scheduleControllerStartup } from './lib/controllerResources'
import { CURRENT_VERSION, GITHUB_REPO, DISMISSED_VERSION_KEY, semverGt } from './lib/updateCheck'
import { startWatchdog, stopWatchdog } from './lib/jogWatchdog'
import { Header } from './components/Header'
import { DRO } from './components/DRO'
import { TabletJogPad } from './components/JogPad'
import { ProbeOrProgramPanel } from './components/ProgramExecutionPanel'

import { GCodeViewer } from './components/GCodeViewer'
import { FileManager, prefetchInternalFiles } from './components/FileManager'
import { Terminal } from './components/Terminal'
import { Macros } from './components/Macros'
import { SettingsPanel } from './components/SettingsPanel'
import { AboutModal } from './components/AboutModal'
import { JobControl } from './components/JobControl'
import { WebUIBlocked } from './components/WebUIBlocked'
import { PluginLauncher } from './components/PluginLauncher'
import { WifiOff, RefreshCw, Crosshair, Monitor, FolderOpen, TerminalSquare, AlertTriangle } from 'lucide-react'
import type { Plugin, Position, SidebarTab, ActiveLayout } from './types'
import { getEffectiveLayout } from './types'
import { PluginFrame } from './components/PluginFrame'
import { DesktopLayout } from './components/DesktopLayout'
import { ManualATCPrompt } from './components/ManualATCPrompt'
import { HoldPrompt } from './components/HoldPrompt'
import { TabletMainShell } from './components/TabletMainShell'
import { ViewportProvider, useViewportMetrics } from './lib/viewport'
import type { TabletTabId } from './lib/tabletTabs'

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: 'files',   label: 'Files'   },
  { id: 'macros',  label: 'Macros'  },
  { id: 'plugins', label: 'Plugins' },
]

type MobilePanel = 'control' | 'viewer' | 'right' | 'terminal'

type Phase = 'connecting' | 'error' | 'ready'

function isZeroPosition(p: Position): boolean {
  return p.x === 0 && p.y === 0 && p.z === 0 && !p.a && !p.b && !p.c
}

function useActiveLayout(layoutMode: 'auto' | 'tablet' | 'desktop'): ActiveLayout {
  const { innerWidth: width } = useViewportMetrics()
  const [isCoarsePointer, setIsCoarsePointer] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(pointer: coarse)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)')
    const onChange = (e: MediaQueryListEvent) => setIsCoarsePointer(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (width < 768) return 'mobile'
  if (layoutMode === 'tablet') return 'tablet'
  if (layoutMode === 'desktop') return 'desktop'
  // Large tablets (iPad Pro, Surface Pro) exceed 1270px in landscape but use touch as primary input
  if (isCoarsePointer) return 'tablet'
  return width < 1270 ? 'tablet' : 'desktop'
}

export function App() {
  return (
    <ViewportProvider>
      <ControllerJobTracker />
      <AppContent />
    </ViewportProvider>
  )
}

// Android Chrome reloads background tabs, which forgets the tracked job. Keep
// it for this tab so a reloaded page still knows when the job started.
const SAVED_CONTROLLER_JOB_KEY = 'fluidui_controller_job'

interface SavedControllerJob {
  startedAt: number
  adopted: boolean
  sdFilename: string
}

function loadSavedControllerJob(): SavedControllerJob | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVED_CONTROLLER_JOB_KEY) ?? 'null')
    return saved && typeof saved.startedAt === 'number' && typeof saved.sdFilename === 'string'
      ? { startedAt: saved.startedAt, adopted: !!saved.adopted, sdFilename: saved.sdFilename }
      : null
  } catch {
    return null
  }
}

function saveControllerJob(job: SavedControllerJob | null) {
  try {
    if (job) sessionStorage.setItem(SAVED_CONTROLLER_JOB_KEY, JSON.stringify(job))
    else sessionStorage.removeItem(SAVED_CONTROLLER_JOB_KEY)
  } catch { /* storage unavailable */ }
}

// Follows controller (SD) jobs through status reports. It is its own component
// so that each status report re-renders only this, not the whole app.
function ControllerJobTracker() {
  const connected = useMachineStore(s => s.connected)
  const machineState = useMachineStore(s => s.status.state)
  const spindleSpeed = useMachineStore(s => s.status.spindle)
  const statusReportCount = useMachineStore(s => s.statusReportCount)
  const spindleSpinupMs = useMachineStore(s => s.controllerSettings.spindleSpinupMs ?? 0)
  const activeJobSource = useGCodeStore(s => s.trackedJob?.source)
  const activeJobStartedAt = useGCodeStore(s => s.trackedJob?.startedAt)
  const activeJobAdopted = useGCodeStore(s => s.trackedJob?.adopted ?? false)
  const startTrackedJob = useGCodeStore(s => s.startTrackedJob)
  const finishTrackedJob = useGCodeStore(s => s.finishTrackedJob)
  const cancelTrackedJob = useGCodeStore(s => s.cancelTrackedJob)
  const interruptTrackedJob = useGCodeStore(s => s.interruptTrackedJob)
  const controllerJobWasRunningRef = useRef(false)
  const controllerJobAwaitingRunAfterSpinupRef = useRef(false)
  const controllerJobSpinupSeenRef = useRef(false)
  const controllerTrackedJobStartedAtRef = useRef<number | null>(null)
  const controllerJobConnectionLossRef = useRef<{
    reportCount: number
    sdPercent: number | null
    line: number | null
    mpos: Position
  } | null>(null)
  const reportCountAtConnectRef = useRef<number | null>(null)
  const adoptionBlockedRef = useRef(false)
  const resumedJobStartedAtRef = useRef<number | null>(null)
  const savedJobStartedAtRef = useRef<number | null>(null)
  const savedJobCheckedRef = useRef(false)

  useEffect(() => {
    reportCountAtConnectRef.current = connected ? useMachineStore.getState().statusReportCount : null
  }, [connected])

  // A reset ends the controller job, whichever button sent it. Stop following
  // it so the Idle that comes next is not announced as a finished job, and do
  // not take the job back from a report sent before the reset landed.
  useEffect(() => onSoftReset(() => {
    adoptionBlockedRef.current = true
    cancelTrackedJob('controller')
  }), [cancelTrackedJob])

  useEffect(() => {
    if (activeJobSource !== 'controller') {
      if (controllerTrackedJobStartedAtRef.current != null) saveControllerJob(null)
      controllerJobWasRunningRef.current = false
      controllerJobAwaitingRunAfterSpinupRef.current = false
      controllerJobSpinupSeenRef.current = false
      controllerTrackedJobStartedAtRef.current = null
      controllerJobConnectionLossRef.current = null

      // Follow an SD job this page did not start: one started from another
      // device, the terminal or a macro, or one that was running before this
      // page loaded. Judge it only by reports that arrived after connecting.
      const reportCountAtConnect = reportCountAtConnectRef.current
      if (activeJobSource || !connected || reportCountAtConnect == null || statusReportCount <= reportCountAtConnect) return
      const sdFilename = useMachineStore.getState().status.sdFilename
      if (machineState !== 'Run' && machineState !== 'Hold') {
        adoptionBlockedRef.current = false
        if (!savedJobCheckedRef.current) {
          // The job saved before a reload ended while the page was away.
          savedJobCheckedRef.current = true
          saveControllerJob(null)
        }
      } else if (sdFilename && !adoptionBlockedRef.current) {
        savedJobCheckedRef.current = true
        const saved = loadSavedControllerJob()
        const resumed = saved?.sdFilename === sdFilename
          ? { startedAt: saved.startedAt, adopted: saved.adopted }
          : { startedAt: Date.now(), adopted: true }
        resumedJobStartedAtRef.current = resumed.startedAt
        startTrackedJob('controller', resumed)
      }
      return
    }

    if (controllerTrackedJobStartedAtRef.current !== activeJobStartedAt) {
      controllerJobWasRunningRef.current = false
      controllerJobAwaitingRunAfterSpinupRef.current = false
      // A job taken over while it was running is already past its spin-up.
      controllerJobSpinupSeenRef.current = activeJobStartedAt != null
        && activeJobStartedAt === resumedJobStartedAtRef.current
      controllerTrackedJobStartedAtRef.current = activeJobStartedAt ?? null
      controllerJobConnectionLossRef.current = null
    }

    // The machine state is kept across a dropped connection. Remember where the
    // job was, and judge it only by reports that arrive after reconnecting.
    if (!connected) {
      if (controllerJobWasRunningRef.current && !controllerJobConnectionLossRef.current) {
        const { status, statusReportCount } = useMachineStore.getState()
        controllerJobConnectionLossRef.current = {
          reportCount: statusReportCount,
          sdPercent: status.sdPercent ?? null,
          line: useGCodeStore.getState().activeSourceLine,
          mpos: status.mpos,
        }
      }
      return
    }
    const loss = controllerJobConnectionLossRef.current
    if (loss) {
      if (statusReportCount === loss.reportCount) return
      controllerJobConnectionLossRef.current = null
      if (machineState !== 'Run' && machineState !== 'Hold') {
        // A controller that restarts drops the connection and comes back idle,
        // which used to read as a finished job. Without homing, it also comes
        // back with its machine position at zero while the toolhead stayed put.
        const mpos = useMachineStore.getState().status.mpos
        interruptTrackedJob('controller', {
          sdPercent: loss.sdPercent,
          line: loss.line,
          controllerRestarted: isZeroPosition(mpos) && !isZeroPosition(loss.mpos),
        })
        return
      }
    }

    if (machineState === 'Run' || machineState === 'Hold') {
      controllerJobWasRunningRef.current = true
      controllerJobAwaitingRunAfterSpinupRef.current = false
      const sdFilename = useMachineStore.getState().status.sdFilename
      if (sdFilename && activeJobStartedAt != null && savedJobStartedAtRef.current !== activeJobStartedAt) {
        savedJobStartedAtRef.current = activeJobStartedAt
        saveControllerJob({ startedAt: activeJobStartedAt, adopted: activeJobAdopted, sdFilename })
      }
    } else if (machineState === 'Idle' && controllerJobWasRunningRef.current) {

      const withinInitialSpinup = spindleSpinupMs > 0
        && activeJobStartedAt != null
        && Date.now() - activeJobStartedAt < spindleSpinupMs
      const spindleIsStarting = spindleSpinupMs > 0 && spindleSpeed > 0
      if (controllerJobAwaitingRunAfterSpinupRef.current) {
        // Keep waiting. Repeated Idle reports are expected throughout the
        // controller's delay and must never be treated as job completion.
      } else if (!controllerJobSpinupSeenRef.current && (withinInitialSpinup || spindleIsStarting)) {
        controllerJobAwaitingRunAfterSpinupRef.current = true
        controllerJobSpinupSeenRef.current = true
      } else {
        finishTrackedJob('controller')
      }
    } else if (machineState === 'Alarm') {
      cancelTrackedJob('controller')
    }
  }, [
    activeJobSource,
    activeJobStartedAt,
    activeJobAdopted,
    connected,
    machineState,
    statusReportCount,
    spindleSpeed,
    spindleSpinupMs,
    startTrackedJob,
    finishTrackedJob,
    cancelTrackedJob,
    interruptTrackedJob,
  ])

  return null
}

function AppContent() {
  const connected = useMachineStore(s => s.connected)
  const statusReceived = useMachineStore(s => s.statusReceived)
  const runningFile = useMachineStore(s => s.status.sdFilename)
  const restarting = useMachineStore(s => s.restarting)
  const sidebarTab = useMachineStore(s => s.sidebarTab)
  const layoutMode = useMachineStore(s => s.layoutMode)
  const setSidebarTab = useMachineStore(s => s.setSidebarTab)
  const setEspInfo = useMachineStore(s => s.setEspInfo)
  const setMacros = useMachineStore(s => s.setMacros)
  const setPendingUpdateVersion = useMachineStore(s => s.setPendingUpdateVersion)
  const setStoreRestarting = useMachineStore(s => s.setRestarting)
  const setStartupPending = useMachineStore(s => s.setStartupPending)
  const clearTerminal = useTerminalStore(s => s.clear)
  const machineState = useMachineStore(s => s.status.state)
  const activeLayout = useActiveLayout(layoutMode)
  const { isCompactLandscape } = useViewportMetrics()
  const compactLandscapeScroll = isCompactLandscape && activeLayout === 'tablet'
  const loadGCodeFile = useGCodeStore(s => s.loadFile)
  const restoreRunningFile = useGCodeStore(s => s.restoreRunningFile)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderFileName = useGCodeSenderStore(s => s.fileName)
  const senderError = useGCodeSenderStore(s => s.error)
  const senderFailureLine = useGCodeSenderStore(s => s.failureLine)
  const senderFailureLineSource = useGCodeSenderStore(s => s.failureLineSource)
  const activeJobSource = useGCodeStore(s => s.trackedJob?.source)
  const finishTrackedJob = useGCodeStore(s => s.finishTrackedJob)
  const cancelTrackedJob = useGCodeStore(s => s.cancelTrackedJob)
  const [phase, setPhase]   = useState<Phase>('connecting')
  const [errMsg, setErrMsg] = useState('')
  const [webUIBlocked, setWebUIBlocked] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const requestSettingsCloseRef = useRef<(() => void) | null>(null)
  const requestSettingsClose = useCallback(() => {
    requestSettingsCloseRef.current?.() ?? setSettingsOpen(false)
  }, [])
  const [aboutOpen, setAboutOpen] = useState(false)
  const [mobilePanel, setMobilePanel]     = useState<MobilePanel>('control')
  const [tabletTab,   setTabletTab]       = useState<TabletTabId>('viewer')
  const [workspacePlugin, setWorkspacePlugin] = useState<Plugin | null>(null)
  const [controlsPlugin,  setControlsPlugin]  = useState<Plugin | null>(null)
  const [fullPlugin,      setFullPlugin]      = useState<Plugin | null>(null)
  const [jogPlugin,       setJogPlugin]       = useState<Plugin | null>(null)

  useEffect(() => {
    let firstFrame: number | null = null
    let secondFrame: number | null = null

    const showConfigEditor = (event: Event) => {
      const studio = event.type === 'config:show-studio'
      if (studio && window.innerWidth < 768) return
      setFullPlugin(null)
      setWorkspacePlugin(null)
      setControlsPlugin(null)
      setSidebarTab('files')
      setMobilePanel('right')
      setTabletTab('files')

      // FileManager only exists while the Files panel is visible.
      // Dispatch once it has mounted and installed its event listener.
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent(studio ? 'config:open-studio' : 'files:open-config-editor'))
        })
      })
    }

    window.addEventListener('files:show-config-editor', showConfigEditor)
    window.addEventListener('config:show-studio', showConfigEditor)
    return () => {
      window.removeEventListener('files:show-config-editor', showConfigEditor)
      window.removeEventListener('config:show-studio', showConfigEditor)
      if (firstFrame !== null) cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
    }
  }, [setSidebarTab])

  const handleLaunchPanel = useCallback((plugin: Plugin) => {
    const layout = getEffectiveLayout(plugin.manifest, activeLayout)
    if (layout === 'workspace') setWorkspacePlugin(plugin)
    else if (layout === 'controls') setControlsPlugin(plugin)
    else if (layout === 'full') setFullPlugin(plugin)
    else if (layout === 'jog') setJogPlugin(plugin)
  }, [activeLayout])

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightPromise = useRef<Promise<boolean> | null>(null)
  const backoffMs = useRef(0)
  const cachedWsHost = useRef<string | null>(null)
  const cachedHostFailures = useRef(0)
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false)
  const restartSawDisconnect = useRef(false)
  const [startupErrors, setStartupErrors] = useState<string[]>([])
  const [startupErrorsOpen, setStartupErrorsOpen] = useState(false)

  useEffect(() => {
    if (activeJobSource !== 'local') return
    if (senderPhase === 'completed') finishTrackedJob('local')
    else if (senderPhase === 'aborted' || senderPhase === 'error') cancelTrackedJob('local')
  }, [activeJobSource, senderPhase, finishTrackedJob, cancelTrackedJob])

  useEffect(() => {
    fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then((data: { tag_name?: string } | null) => {
        if (!data) return
        const latest = (data.tag_name ?? '').replace(/^v/, '')
        if (!latest) return
        const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY)
        if (semverGt(latest, CURRENT_VERSION) && latest !== dismissed) {
          setPendingUpdateVersion(latest)
        }
      })
  }, [])

  async function resolveWsHost(httpHost: string): Promise<{ wsHost: string; info: ReturnType<typeof parseESP800> | null }> {
    if (cachedWsHost.current && cachedHostFailures.current < 3) {
      return { wsHost: cachedWsHost.current, info: null }
    }

    const raw  = cachedWsHost.current === null && cachedHostFailures.current > 0
      ? await getDeviceInfoFast()
      : await getDeviceInfo()
    const info = parseESP800(raw)
    const asyncMode = info['WebCommunication']?.trim() === 'Asynchronous'
    const wsPort = info['WebSocketPort']?.trim() || '80'
    const wsIp   = info['WebSocketIP']?.trim() || httpHost.split(':')[0]
    const wsHost = asyncMode
      ? `${httpHost}/ws`
      : wsPort === '80' ? wsIp : `${wsIp}:${wsPort}`
    cachedWsHost.current = wsHost
    cachedHostFailures.current = 0
    // Only refresh ESP info on a fresh probe.
    const axes = (info['Axisletters'] ?? '').length
    setEspInfo({
      version:        info['FWVersion']?.trim()       ?? '',
      hostname:       info['HostName']?.trim()         ?? httpHost,
      authentication: info['Authentication']?.trim()   === 'Enabled',
      asyncMode,
      wsPort:         parseInt(wsPort, 10),
      wsIp,
      axes:           axes || 3,
      // No JSON equivalent for these (the legacy plain-text response's
      // "primary sd"/"secondary sd" fields) -- same defaults the old
      // parse already fell back to whenever they were absent/unparseable.
      primarySd:      '/sd/',
      secondarySd:    '/ext/',
    })
    return { wsHost, info }
  }

  function attemptConnect(): Promise<boolean> {
    if (inFlightPromise.current) return inFlightPromise.current
    const p = (async () => {
      try {
        const httpHost = window.location.host
        // The page's own origin, so an https page (e.g. the wasm demo) does
        // not make http requests, which the browser blocks as mixed content
        setBase(isWasmBridgeActive() ? WASM_BRIDGE_BASE : window.location.origin)
        const { wsHost } = await resolveWsHost(httpHost)
        await connect(wsHost)
        cachedHostFailures.current = 0
        return true
      } catch (e) {
        cachedHostFailures.current++
        if (cachedHostFailures.current >= 3) cachedWsHost.current = null
        if (phase !== 'ready') {
          setErrMsg(e instanceof Error ? e.message : 'Connection failed')
          setWebUIBlocked(e instanceof WebUIBlockedError)
        }
        return false
      } finally {
        inFlightPromise.current = null
      }
    })()
    inFlightPromise.current = p
    return p
  }

  function scheduleReconnect() {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    // Exponential backoff, cap @ 30s.
    const next = backoffMs.current === 0 ? 1000 : Math.min(backoffMs.current * 2, 30000)
    backoffMs.current = next
    reconnectTimer.current = setTimeout(async () => {
      reconnectTimer.current = null
      if (isSocketOpen()) return
      await attemptConnect()
      if (!isSocketOpen()) scheduleReconnect()
    }, next)
  }

  // Initial connect (runs once).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const ok = await attemptConnect()
      if (cancelled) return
      if (ok || isSocketOpen()) {
        setPhase('ready')
      } else {
        setPhase('error')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'ready') return
    if (connected) {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      backoffMs.current = 0
    } else {
      setStartupPending(false)
      if (!reconnectTimer.current) {
        // Respect existing backoff so rapid connect/drop loops slow down.
        const delay = backoffMs.current > 0 ? Math.min(backoffMs.current, 30000) : 300
        reconnectTimer.current = setTimeout(async () => {
          reconnectTimer.current = null
          if (isSocketOpen()) return
          await attemptConnect()
          if (!isSocketOpen()) scheduleReconnect()
        }, delay)
      }
    }
  }, [connected, phase])

  const macrosLoaded = useRef(false)
  useEffect(() => {
    if (phase !== 'ready' || !connected) return
    return scheduleControllerStartup(async canContinue => {
      if (!await sendStartupQueries(canContinue)) return false
      await loadControllerConfigSettings().catch(() => {})
      if (!canContinue()) return false
      if (!macrosLoaded.current) {
        const data = await loadMacroCfg()
        if (!canContinue()) return false
        if (data.length > 0) setMacros(data)
        macrosLoaded.current = true
      }
      if (!canContinue()) return false
      await prefetchInternalFiles()
      return canContinue()
    }, setStartupPending)
  }, [connected, phase, setMacros, setStartupPending])

  useEffect(() => {
    if (!restarting) {
      restartSawDisconnect.current = false
      return
    }
    if (!connected) {
      restartSawDisconnect.current = true
    } else if (restartSawDisconnect.current) {
      restartSawDisconnect.current = false
      clearTerminal()
      setStoreRestarting(false)
    }
  }, [restarting, connected, setStoreRestarting, clearTerminal])

  useEffect(() => {
    if (!restarting) return
    const t = setTimeout(() => setStoreRestarting(false), 60_000)
    return () => clearTimeout(t)
  }, [restarting, setStoreRestarting])

  useEffect(() => {
    if (!connected) return
    let errors: string[] = []
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (fallbackTimer !== null) clearTimeout(fallbackTimer)
      fallbackTimer = null
      if (errors.length > 0) {
        setStartupErrors(errors)
        setStartupErrorsOpen(true)
        errors = []
      }
    }

    const unsub = onLine((line: string) => {
      if (line.includes('[MSG:ERR:') && line.includes('Configuration error')) {
        errors.push(line)
        if (fallbackTimer === null) fallbackTimer = setTimeout(finish, 5000)
      } else if (line === 'ok' || line.startsWith('error:')) {
        finish()
      }
    })

    return () => {
      unsub()
      if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    }
  }, [connected])

  // Debounce the "Reconnecting…" overlay so transient drops don't flash it.
  useEffect(() => {
    if (phase !== 'ready') {
      setShowReconnectOverlay(false)
      return
    }
    if (connected) {
      setShowReconnectOverlay(false)
      return
    }
    const t = setTimeout(() => setShowReconnectOverlay(true), 1500)
    return () => clearTimeout(t)
  }, [connected, phase])

  useEffect(() => {
    function kick() {
      if (isSocketOpen()) return
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      backoffMs.current = 0
      attemptConnect().then(() => {
        if (!isSocketOpen()) scheduleReconnect()
      })
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') kick()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Manual retry from the error screen.
  async function retryFromError() {
    setPhase('connecting')
    setErrMsg('')
    setWebUIBlocked(false)
    backoffMs.current = 0
    cachedWsHost.current = null
    cachedHostFailures.current = 0
    const ok = await attemptConnect()
    setPhase(ok ? 'ready' : 'error')
  }

  useEffect(() => {
    if (!connected) {
      stopWatchdog()
      return
    }
    startWatchdog()
  }, [connected])

  useEffect(() => {
    if (!settingsOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        requestSettingsClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, requestSettingsClose])

  useEffect(() => {
    if (connected && statusReceived && runningFile) void restoreRunningFile(runningFile)
  }, [connected, statusReceived, runningFile, restoreRunningFile])

  // On mobile/tablet, switch to the viewer when a file is selected; also kick off
  // the single shared download via the gcode store.
  useEffect(() => {
    function showGcodeViewer() {
      setMobilePanel('viewer')
      setTabletTab('viewer')
    }

    function onGcodeLoad(e: Event) {
      if (machineState === 'Run' || machineState === 'Hold') return
      const path = (e as CustomEvent<string>).detail
      loadGCodeFile(path)
      showGcodeViewer()
    }
    window.addEventListener('gcode:load', onGcodeLoad as EventListener)
    window.addEventListener('gcode:preview-upload', showGcodeViewer)
    return () => {
      window.removeEventListener('gcode:load', onGcodeLoad as EventListener)
      window.removeEventListener('gcode:preview-upload', showGcodeViewer)
    }
  }, [loadGCodeFile, machineState])

  if (phase === 'connecting') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]">
        <RefreshCw size={28} className="text-accent animate-spin" />
        <span className="text-text-muted text-base">Connecting to FluidNC…</span>
        <span className="text-text-dim text-sm font-mono">{window.location.host}</span>
      </div>
    )
  }

  if (phase === 'error') {
    if (webUIBlocked) {
      return <WebUIBlocked base={getBase()} onReload={retryFromError} />
    }
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]">
        <WifiOff size={28} className="text-danger" />
        <span className="text-text-primary text-base font-medium">Could not connect</span>
        <span className="text-danger text-sm max-w-xs text-center">{errMsg}</span>
        <span className="text-text-dim text-sm font-mono">{window.location.host}</span>
        <button className="btn-primary mt-2" onClick={retryFromError}>
          Retry
        </button>
      </div>
    )
  }

  const sidebarTabBar = (
    <div className="flex border-b border-border shrink-0">
      {SIDEBAR_TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => setSidebarTab(tab.id)}
          className={`flex-1 py-2.5 text-xl font-medium uppercase tracking-wide
                      transition-colors border-b-2 -mb-px ${
            sidebarTab === tab.id
              ? 'border-accent text-accent'
              : 'border-transparent text-text-muted'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )

  const streamRecoveryNotice = senderPhase === 'error' && senderFailureLine != null ? (
    <div className="mx-4 w-full max-w-md rounded-lg border border-warn/40 bg-surface px-4 py-3.5 shadow-2xl">
      <div className="flex items-center gap-2 text-warn font-semibold">
        <AlertTriangle size={17} className="shrink-0" />
        Local job interrupted
      </div>
      {senderFileName && <div className="mt-2 truncate font-mono text-sm text-text-primary">{senderFileName}</div>}
      <div className="mt-2 text-sm text-text-primary">
        {senderFailureLineSource === 'position' ? (
          <>Suggested recovery line: <span className="font-mono font-semibold text-accent">{senderFailureLine}</span></>
        ) : (
          <>Last acknowledged line: <span className="font-mono font-semibold">{senderFailureLine}</span></>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
        {senderFailureLineSource === 'position'
          ? 'Keep this page open. After reconnecting, review this line against the machine’s actual stop position before preparing a restart.'
          : 'Execution position was unavailable, so this is not a safe restart suggestion. Keep this page open until the controller reconnects.'}
      </p>
      {senderError && <div className="mt-2 border-t border-border pt-2 font-mono text-[11px] text-text-dim">{senderError}</div>}
    </div>
  ) : null

  return (
    <div className={`flex flex-col min-h-[100svh] md:h-[100svh] md:overflow-hidden bg-[var(--bg)] relative ${
      compactLandscapeScroll
        ? 'landscape:h-auto landscape:min-h-[100svh] landscape:overflow-y-auto'
        : 'landscape:h-[100svh] landscape:overflow-hidden'
    }`}>
      {restarting ? (
        <div className="fixed md:absolute inset-0 z-[120] bg-[var(--bg)]/80 backdrop-blur-sm
                        flex flex-col items-center justify-center gap-3">
          <RefreshCw size={24} className="text-accent animate-spin" />
          <span className="text-text-primary text-base font-medium">Restarting controller…</span>
          <span className="text-text-muted text-sm">Waiting for FluidNC to come back online</span>
          {streamRecoveryNotice}
        </div>
      ) : showReconnectOverlay && (
        <div className="fixed md:absolute inset-0 z-[120] bg-[var(--bg)]/80 backdrop-blur-sm
                        flex flex-col items-center justify-center gap-3">
          <RefreshCw size={24} className="text-accent animate-spin" />
          <span className="text-text-muted text-base">Reconnecting…</span>
          {streamRecoveryNotice}
        </div>
      )}

      <Header
        onSettingsClick={() => setSettingsOpen(true)}
        onAboutClick={() => setAboutOpen(true)}
        sticky={compactLandscapeScroll}
      />

      <ManualATCPrompt />
      <HoldPrompt />

      {fullPlugin && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-3">
          <div className="panel flex flex-col flex-1 min-h-0 overflow-hidden">
            <PluginFrame plugin={fullPlugin} onClose={() => setFullPlugin(null)} inline />
          </div>
        </div>
      )}

      {!fullPlugin && activeLayout === 'mobile' && <div className="flex flex-col">
        {mobilePanel === 'control' && (
          <div className="flex flex-col gap-3 p-3 pb-20">
            <DRO />
            <JobControl />
            {jogPlugin ? (
              <div className="panel flex flex-col h-[60vh] overflow-hidden">
                <PluginFrame plugin={jogPlugin} onClose={() => setJogPlugin(null)} inline />
              </div>
            ) : (
              <TabletJogPad />
            )}
            <ProbeOrProgramPanel />
          </div>
        )}

        <div className={`h-[calc(100dvh-3rem)] flex flex-col gap-3 p-3 pb-[4.5rem] overflow-hidden ${mobilePanel !== 'viewer' ? 'hidden' : ''}`}>
          <GCodeViewer className="flex-1 min-h-0" showOverrides />
        </div>

        {mobilePanel === 'right' && (
          <div className="h-[calc(100dvh-3rem)] flex flex-col gap-3 p-3 pb-[4.5rem] overflow-hidden">
            <div className="panel flex flex-col flex-1 min-h-0 overflow-hidden">
              {sidebarTabBar}
              <div className="flex-1 min-h-0 overflow-hidden">
                {sidebarTab === 'files'   && <FileManager isTablet />}
                {sidebarTab === 'macros'  && <Macros />}
                {sidebarTab === 'plugins' && <PluginLauncher />}
              </div>
            </div>
          </div>
        )}

        {mobilePanel === 'terminal' && (
          <div className="h-[calc(100dvh-3rem)] flex flex-col p-3 pb-[4.5rem] overflow-hidden">
            <div className="panel flex flex-col flex-1 min-h-0 overflow-hidden">
              <Terminal />
            </div>
          </div>
        )}
      </div>}

      {!fullPlugin && activeLayout === 'mobile' && <nav className="fixed bottom-0 left-0 right-0 z-40 h-16 bg-surface border-t border-border flex items-stretch">
        {([
          { id: 'control'  as MobilePanel, Icon: Crosshair,    label: 'Control' },
          { id: 'viewer'   as MobilePanel, Icon: Monitor,      label: 'Viewer'  },
          { id: 'right'    as MobilePanel, Icon: FolderOpen,   label: 'Files'   },
          { id: 'terminal' as MobilePanel, Icon: TerminalSquare, label: 'Term'  },
        ] as const).map(({ id, Icon, label }) => (
          <button
            key={id}
            onClick={() => setMobilePanel(id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-sm font-medium
                        transition-colors ${
              mobilePanel === id ? 'text-accent' : 'text-text-muted'
            }`}
          >
            <Icon size={20} />
            {label}
          </button>
        ))}
      </nav>}


      {!fullPlugin && activeLayout === 'tablet' && (
        <TabletMainShell
          tabletTab={tabletTab}
          setTabletTab={setTabletTab}
          onLaunchPanel={handleLaunchPanel}
          jogPlugin={jogPlugin}
          onCloseJogPlugin={() => setJogPlugin(null)}
          workspacePlugin={workspacePlugin}
          onCloseWorkspacePlugin={() => setWorkspacePlugin(null)}
          controlsPlugin={controlsPlugin}
          onCloseControlsPlugin={() => setControlsPlugin(null)}
        />
      )}

      {!fullPlugin && activeLayout === 'desktop' && (
        <DesktopLayout
          workspacePlugin={workspacePlugin}
          controlsPlugin={controlsPlugin}
          jogPlugin={jogPlugin}
          onCloseWorkspacePlugin={() => setWorkspacePlugin(null)}
          onCloseControlsPlugin={() => setControlsPlugin(null)}
          onCloseJogPlugin={() => setJogPlugin(null)}
          onLaunchPanel={handleLaunchPanel}
          activeLayout={activeLayout}
        />
      )}


      {settingsOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4"
          onClick={e => { if (e.target === e.currentTarget) requestSettingsClose() }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative w-full sm:max-w-3xl
                          h-[92dvh] sm:h-[min(85vh,720px)]
                          bg-surface border-t sm:border border-border
                          rounded-t-2xl sm:rounded-lg
                          shadow-2xl flex flex-col overflow-hidden animate-in">
            <SettingsPanel
              onClose={() => setSettingsOpen(false)}
              onRequestCloseReady={requestClose => {
                requestSettingsCloseRef.current = requestClose
              }}
            />
          </div>
        </div>
      )}

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}


      {startupErrorsOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4"
          onClick={e => { if (e.target === e.currentTarget) setStartupErrorsOpen(false) }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative w-full sm:max-w-lg
                          bg-surface border-t sm:border border-border
                          rounded-t-2xl sm:rounded-lg
                          shadow-2xl flex flex-col overflow-hidden animate-in">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
              <AlertTriangle size={20} className="text-red-400 shrink-0" />
              <h2 className="text-2xl font-semibold text-text-primary flex-1">Configuration Errors</h2>
              <button
                onClick={() => setStartupErrorsOpen(false)}
                className="text-text-muted hover:text-text-primary transition-colors"
                aria-label="Dismiss"
              >✕</button>
            </div>
            <p className="px-5 pt-4 pb-2 text-xl text-text-muted">
              FluidNC reported the following errors while loading <code className="text-text-primary">config.yaml</code>:
            </p>
            <div className="px-5 pb-5 flex flex-col gap-2 overflow-y-auto max-h-72">
              {startupErrors.map((line, i) => (
                <pre key={i} className="text-base text-red-400 rounded px-3 py-2 whitespace-pre-wrap break-all font-mono">
                  {line}
                </pre>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-border flex justify-end">
              <button
                onClick={() => setStartupErrorsOpen(false)}
                className="px-4 py-2 text-base font-medium bg-accent text-white rounded hover:opacity-90 transition-opacity"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
