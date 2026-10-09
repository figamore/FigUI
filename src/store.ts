import { create } from 'zustand'
import type {
  MachineStatus,
  MachineState,
  Position,
  ESPInfo,
  SidebarTab,
  PositionMode,
  JogStep,
  Macro,
  Units,
  LayoutMode,
  ControllerSettings,
  FluidNCSetting,
} from './types'

export type Theme = 'light' | 'dark' | 'anthracite-dark' | 'midnight-dark'

const DARK_THEME_CLASSES = ['dark', 'anthracite-dark', 'midnight-dark'] as const

function isValidTheme(v: string | null): v is Theme {
  return v === 'light' || v === 'dark' || v === 'anthracite-dark' || v === 'midnight-dark'
}

function applyThemeClass(theme: Theme) {
  document.documentElement.classList.remove(...DARK_THEME_CLASSES)
  if (theme !== 'light') document.documentElement.classList.add(theme)
}

const _savedTheme = localStorage.getItem('theme')
const _initialTheme: Theme = isValidTheme(_savedTheme) ? _savedTheme : 'midnight-dark'
applyThemeClass(_initialTheme)


export interface WatchdogState {
  enabled: boolean
  monitoring: boolean
  alertLevel: 'none' | 'warning' | 'emergency'
  lastTrigger: number
  escalationStartTime: number
  inputState: {
    activeKeys: Set<string>
    mouseDown: boolean
    lastActivity: number
  }
  connectionHealth: {
    lastResponse: number
    missedPings: number
  }
}

function countDefinedAxes(pos: Position): number {
  if (pos.c !== undefined) return 6
  if (pos.b !== undefined) return 5
  if (pos.a !== undefined) return 4
  return 3
}

function subtractPos(a: Position, b: Position): Position {
  return {
    x: a.x - b.x, y: a.y - b.y, z: a.z - b.z,
    a: a.a != null && b.a != null ? a.a - b.a : a.a,
    b: a.b != null && b.b != null ? a.b - b.b : a.b,
    c: a.c != null && b.c != null ? a.c - b.c : a.c,
  }
}

function addPos(a: Position, b: Position): Position {
  return {
    x: a.x + b.x, y: a.y + b.y, z: a.z + b.z,
    a: a.a != null && b.a != null ? a.a + b.a : a.a,
    b: a.b != null && b.b != null ? a.b + b.b : a.b,
    c: a.c != null && b.c != null ? a.c + b.c : a.c,
  }
}

function inferMachineRangePositive(mpos: number, maxTravel?: number): boolean | undefined {
  if (!Number.isFinite(mpos) || maxTravel == null || !Number.isFinite(maxTravel) || maxTravel <= 0) {
    return undefined
  }
  const tolerance = Math.min(5, Math.max(1, maxTravel * 0.01))
  if (mpos > tolerance) return true
  if (mpos < -tolerance) return false
  return undefined
}

function inferMachineRangeFromPosition(mpos: number, maxTravel?: number) {
  const rangePositive = inferMachineRangePositive(mpos, maxTravel)
  if (rangePositive === undefined || maxTravel == null) return null
  return rangePositive
    ? { min: 0, max: maxTravel }
    : { min: -maxTravel, max: 0 }
}

function normalizeSettingPath(path: string) {
  return path.replace(/^\/+/, '').toLowerCase()
}

function getSettingNumber(settings: FluidNCSetting[], path: string): number | undefined {
  const normalized = normalizeSettingPath(path)
  const setting = settings.find(s => normalizeSettingPath(s.P) === normalized)
  if (!setting) return undefined
  const value = Number.parseFloat(setting.V)
  return Number.isFinite(value) ? value : undefined
}

function getSpindleDelaySetting(settings: FluidNCSetting[], name: 'spinup_ms' | 'spindown_ms') {
  const setting = settings.find(s => normalizeSettingPath(s.P).endsWith(`/${name}`))
  if (!setting) return undefined
  const value = Number.parseFloat(setting.V)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function getSettingBoolean(settings: FluidNCSetting[], path: string): boolean | undefined {
  const normalized = normalizeSettingPath(path)
  const setting = settings.find(s => normalizeSettingPath(s.P) === normalized)
  if (!setting) return undefined
  const value = setting.V.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return undefined
}

function hasFluidNCAxisRange(settings: FluidNCSetting[] | null, axis: 'x' | 'y' | 'z') {
  if (!settings) return false
  return getSettingNumber(settings, `axes/${axis}/max_travel_mm`) !== undefined
    && getSettingNumber(settings, `axes/${axis}/homing/mpos_mm`) !== undefined
    && getSettingBoolean(settings, `axes/${axis}/homing/positive_direction`) !== undefined
}

function getFluidNCAxisRange(settings: FluidNCSetting[], axis: 'x' | 'y' | 'z') {
  const maxTravel = getSettingNumber(settings, `axes/${axis}/max_travel_mm`)
  const homingMpos = getSettingNumber(settings, `axes/${axis}/homing/mpos_mm`)
  const positiveDirection = getSettingBoolean(settings, `axes/${axis}/homing/positive_direction`)
  if (
    maxTravel == null ||
    homingMpos == null ||
    positiveDirection == null ||
    !Number.isFinite(maxTravel) ||
    maxTravel <= 0
  ) {
    return null
  }
  return positiveDirection
    ? { min: homingMpos - maxTravel, max: homingMpos, maxTravel }
    : { min: homingMpos, max: homingMpos + maxTravel, maxTravel }
}

function deriveControllerSettingsFromFluidNCSettings(settings: FluidNCSetting[]): Partial<ControllerSettings> {
  const derived: Partial<ControllerSettings> = {}
  for (const axis of ['X', 'Y', 'Z', 'A', 'B', 'C'] as const) {
    const maxRate = getSettingNumber(settings, `axes/${axis}/max_rate_mm_per_min`)
      ?? getSettingNumber(settings, `Grbl/MaxRate/${axis}`)
    if (maxRate !== undefined) derived[`maxRate${axis}`] = maxRate
  }
  const reportInches = getSettingBoolean(settings, 'report_inches')
    ?? getSettingBoolean(settings, 'report/inches')
  if (reportInches !== undefined) derived.reportInches = reportInches

  const spinupMs = getSpindleDelaySetting(settings, 'spinup_ms')
  const spindownMs = getSpindleDelaySetting(settings, 'spindown_ms')
  if (spinupMs !== undefined) derived.spindleSpinupMs = spinupMs
  if (spindownMs !== undefined) derived.spindleSpindownMs = spindownMs

  const xRange = getFluidNCAxisRange(settings, 'x')
  const yRange = getFluidNCAxisRange(settings, 'y')
  const zRange = getFluidNCAxisRange(settings, 'z')

  if (xRange) {
    derived.maxTravelX = xRange.maxTravel
    derived.machineMinX = xRange.min
    derived.machineMaxX = xRange.max
    derived.machineRangePositiveX = xRange.min >= 0
  } else {
    const maxTravelX = getSettingNumber(settings, 'axes/x/max_travel_mm')
    if (maxTravelX !== undefined) derived.maxTravelX = maxTravelX
  }
  if (yRange) {
    derived.maxTravelY = yRange.maxTravel
    derived.machineMinY = yRange.min
    derived.machineMaxY = yRange.max
    derived.machineRangePositiveY = yRange.min >= 0
  } else {
    const maxTravelY = getSettingNumber(settings, 'axes/y/max_travel_mm')
    if (maxTravelY !== undefined) derived.maxTravelY = maxTravelY
  }
  if (zRange) {
    derived.maxTravelZ = zRange.maxTravel
    derived.machineMinZ = zRange.min
    derived.machineMaxZ = zRange.max
    derived.machineRangePositiveZ = zRange.min >= 0
  } else {
    const maxTravelZ = getSettingNumber(settings, 'axes/z/max_travel_mm')
    if (maxTravelZ !== undefined) derived.maxTravelZ = maxTravelZ
  }

  return derived
}

const DEFAULT_STATUS: MachineStatus = {
  state: 'Unknown',
  wpos: { x: 0, y: 0, z: 0 },
  mpos: { x: 0, y: 0, z: 0 },
  wco: { x: 0, y: 0, z: 0 },
  feed: 0,
  spindle: 0,
  spindleRunning: false,
  feedOverride: 100,
  rapidOverride: 100,
  spindleOverride: 100,
  pinState: '',
}

const DEFAULT_WATCHDOG_STATE: WatchdogState = {
  enabled: true,
  monitoring: false,
  alertLevel: 'none',
  lastTrigger: 0,
  escalationStartTime: 0,
  inputState: {
    activeKeys: new Set(),
    mouseDown: false,
    lastActivity: Date.now()
  },
  connectionHealth: {
    lastResponse: Date.now(),
    missedPings: 0
  }
}

// Macros are loaded from the controller at runtime (see Macros.tsx).
// We start empty; localStorage is no longer used for macros.

interface Store {
  connected: boolean
  restarting: boolean
  controllerResetPending: boolean
  startupPending: boolean
  status: MachineStatus
  espInfo: ESPInfo | null
  controllerSettings: ControllerSettings
  controllerConfigSettings: FluidNCSetting[] | null
  controllerConfigLoading: boolean
  controllerConfigError: string | null
  controllerConfigLoadedAt: number | null
  theme: Theme
  units: Units
  layoutMode: LayoutMode
  positionMode: PositionMode
  sidebarTab: SidebarTab
  jogStep: JogStep
  axes: number
  macros: Macro[]
  watchdog: WatchdogState
  activeStepJog: {
    active: boolean
    startTime: number
    expectedDistance: number
    axis: string
  } | null

  setConnected: (v: boolean) => void
  setRestarting: (v: boolean) => void
  setControllerResetPending: (v: boolean) => void
  setStartupPending: (v: boolean) => void
  updateStatus: (s: Partial<MachineStatus>) => void
  setEspInfo: (info: ESPInfo) => void
  updateControllerSettings: (settings: Partial<ControllerSettings>) => void
  setControllerConfigLoading: (v: boolean) => void
  setControllerConfigError: (v: string | null) => void
  setControllerConfigSettings: (settings: FluidNCSetting[]) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setUnits: (units: Units) => void
  setLayoutMode: (mode: LayoutMode) => void
  setPositionMode: (m: PositionMode) => void
  setSidebarTab: (t: SidebarTab) => void
  setJogStep: (s: JogStep) => void
  setAxes: (n: number) => void
  setMacros: (macros: Macro[]) => void
  setWatchdogState: (state: Partial<WatchdogState>) => void
  setActiveStepJog: (stepJog: Store['activeStepJog']) => void
  pendingUpdateVersion: string | null
  setPendingUpdateVersion: (v: string | null) => void
}

export const useMachineStore = create<Store>((set) => ({
  connected: false,
  restarting: false,
  controllerResetPending: false,
  startupPending: false,
  status: DEFAULT_STATUS,
  espInfo: null,
  controllerSettings: {},
  controllerConfigSettings: null,
  controllerConfigLoading: false,
  controllerConfigError: null,
  controllerConfigLoadedAt: null,
  theme: _initialTheme,
  units: localStorage.getItem('units') === 'in' ? 'in' : 'mm',
  layoutMode: ((): LayoutMode => {
    const v = localStorage.getItem('layoutMode')
    return v === 'tablet' || v === 'desktop' ? v : 'auto'
  })(),
  positionMode: 'WPos',
  sidebarTab: 'files',
  jogStep: 1,
  axes: 3,
  macros: [],
  watchdog: DEFAULT_WATCHDOG_STATE,
  activeStepJog: null,
  pendingUpdateVersion: null,

  setConnected: (connected) => set({ connected }),
  setRestarting: (restarting) => set({ restarting }),
  setControllerResetPending: (controllerResetPending) => set({ controllerResetPending }),
  setStartupPending: (startupPending) => set({ startupPending }),

  updateStatus: (s) =>
    set(state => {
      const merged = { ...state.status, ...s }
      const wco = merged.wco
      // Derive the missing position from the one reported + WCO
      if (s.mpos && !s.wpos) {
        merged.wpos = subtractPos(merged.mpos, wco)
      } else if (s.wpos && !s.mpos) {
        merged.mpos = addPos(merged.wpos, wco)
      }
      // Clear alarm name when leaving alarm state
      if (s.state && s.state !== 'Alarm') {
        merged.alarmName = undefined
      }
      // Auto-detect axis count from reported positions — only ever increases
      const detectedAxes = Math.max(
        state.axes,
        countDefinedAxes(merged.mpos),
        countDefinedAxes(merged.wpos),
      )

      const detectedSettings: Partial<ControllerSettings> = {}
      const xRange = inferMachineRangeFromPosition(merged.mpos.x, state.controllerSettings.maxTravelX)
      const yRange = inferMachineRangeFromPosition(merged.mpos.y, state.controllerSettings.maxTravelY)
      const zRange = inferMachineRangeFromPosition(merged.mpos.z, state.controllerSettings.maxTravelZ)
      if (
        xRange &&
        !hasFluidNCAxisRange(state.controllerConfigSettings, 'x') &&
        (xRange.min !== state.controllerSettings.machineMinX || xRange.max !== state.controllerSettings.machineMaxX)
      ) {
        detectedSettings.machineMinX = xRange.min
        detectedSettings.machineMaxX = xRange.max
        detectedSettings.machineRangePositiveX = xRange.min >= 0
      }
      if (
        yRange &&
        !hasFluidNCAxisRange(state.controllerConfigSettings, 'y') &&
        (yRange.min !== state.controllerSettings.machineMinY || yRange.max !== state.controllerSettings.machineMaxY)
      ) {
        detectedSettings.machineMinY = yRange.min
        detectedSettings.machineMaxY = yRange.max
        detectedSettings.machineRangePositiveY = yRange.min >= 0
      }
      if (
        zRange &&
        !hasFluidNCAxisRange(state.controllerConfigSettings, 'z') &&
        (zRange.min !== state.controllerSettings.machineMinZ || zRange.max !== state.controllerSettings.machineMaxZ)
      ) {
        detectedSettings.machineMinZ = zRange.min
        detectedSettings.machineMaxZ = zRange.max
        detectedSettings.machineRangePositiveZ = zRange.min >= 0
      }

      return Object.keys(detectedSettings).length > 0
        ? {
            status: merged,
            axes: detectedAxes,
            controllerSettings: {
              ...state.controllerSettings,
              ...detectedSettings,
            },
          }
        : { status: merged, axes: detectedAxes }
    }),

  setEspInfo: (espInfo) =>
    set(state => ({ espInfo, axes: espInfo.axes || state.axes })),

  updateControllerSettings: (settings) =>
    set(state => ({
      controllerSettings: {
        ...state.controllerSettings,
        ...settings,
      },
    })),

  setControllerConfigLoading: (controllerConfigLoading) => set({ controllerConfigLoading }),
  setControllerConfigError: (controllerConfigError) => set({ controllerConfigError }),
  setControllerConfigSettings: (controllerConfigSettings) =>
    set(state => ({
      controllerConfigSettings,
      controllerConfigLoading: false,
      controllerConfigError: null,
      controllerConfigLoadedAt: Date.now(),
      controllerSettings: {
        ...state.controllerSettings,
        ...deriveControllerSettingsFromFluidNCSettings(controllerConfigSettings),
      },
    })),

  setTheme: (theme) =>
    set(() => {
      if (theme !== 'light') localStorage.setItem('darkTheme', theme)
      localStorage.setItem('theme', theme)
      applyThemeClass(theme)
      return { theme }
    }),

  toggleTheme: () =>
    set(state => {
      let theme: Theme
      if (state.theme === 'light') {
        const saved = localStorage.getItem('darkTheme')
        theme = isValidTheme(saved) && saved !== 'light' ? saved : 'midnight-dark'
      } else {
        localStorage.setItem('darkTheme', state.theme)
        theme = 'light'
      }
      localStorage.setItem('theme', theme)
      applyThemeClass(theme)
      return { theme }
    }),

  setUnits: (units) =>
    set(() => {
      localStorage.setItem('units', units)
      return { units }
    }),

  setLayoutMode: (layoutMode) =>
    set(() => {
      localStorage.setItem('layoutMode', layoutMode)
      return { layoutMode }
    }),

  setPositionMode: (positionMode) => set({ positionMode }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setJogStep: (jogStep) => set({ jogStep }),
  setAxes: (axes) => set({ axes }),

  setMacros: (macros) => set({ macros }),

  setWatchdogState: (state) =>
    set(prev => ({
      watchdog: {
        ...prev.watchdog,
        ...state,
        // Ensure inputState is properly merged if provided
        inputState: state.inputState ? { ...prev.watchdog.inputState, ...state.inputState } : prev.watchdog.inputState,
        // Ensure connectionHealth is properly merged if provided
        connectionHealth: state.connectionHealth ? { ...prev.watchdog.connectionHealth, ...state.connectionHealth } : prev.watchdog.connectionHealth
      }
    })),

  setActiveStepJog: (stepJog) => set({ activeStepJog: stepJog }),
  setPendingUpdateVersion: (pendingUpdateVersion) => set({ pendingUpdateVersion }),
}))

export const stateColor = (state: MachineState): string => {
  switch (state) {
    case 'Idle': return 'text-ok'
    case 'Run': return 'text-info'
    case 'Jog': return 'text-info'
    case 'Hold': return 'text-warn'
    case 'Home': return 'text-info'
    case 'Check': return 'text-warn'
    case 'Alarm': return 'text-danger'
    case 'Door': return 'text-danger'
    case 'Sleep': return 'text-text-muted'
    default: return 'text-text-muted'
  }
}

export const stateBg = (state: MachineState): string => {
  switch (state) {
    case 'Idle': return 'bg-ok/10 border-ok/30'
    case 'Run': return 'bg-info/10 border-info/30'
    case 'Jog': return 'bg-info/10 border-info/30'
    case 'Hold': return 'bg-warn/10 border-warn/30'
    case 'Home': return 'bg-info/10 border-info/30'
    case 'Alarm': return 'bg-danger/10 border-danger/30'
    case 'Door': return 'bg-danger/10 border-danger/30'
    default: return 'bg-elevated border-border'
  }
}

export const activePosition = (status: MachineStatus, mode: PositionMode): Position =>
  mode === 'MPos' ? status.mpos : status.wpos
