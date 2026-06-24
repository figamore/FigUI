export type MachineState =
  | 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm'
  | 'Door' | 'Check' | 'Home' | 'Sleep' | 'Unknown'

export interface Position {
  x: number
  y: number
  z: number
  a?: number
  b?: number
  c?: number
}

export interface GCodeModes {
  motion?: string
  wcs?: string
  plane?: string
  units?: string
  distance?: string
  arcDistance?: string
  feedRateMode?: string
  cutterComp?: string
  toolLength?: string
  programState?: string
  spindle?: string
  coolant?: string
  tool?: number
  feed?: number
  spindleSpeed?: number
}

export interface MachineStatus {
  state: MachineState
  alarmCode?: number
  alarmName?: string
  wpos: Position
  mpos: Position
  wco: Position
  feed: number
  spindle: number
  spindleRunning?: boolean
  feedOverride: number
  rapidOverride: number
  spindleOverride: number
  pinState: string
  sdFilename?: string
  sdPercent?: number
  /** FluidNC |Ln:N| — N word on the planner block currently executing */
  lineNumber?: number
  gcodeModes?: GCodeModes
}

export interface FileEntry {
  name: string
  size: number
  isDir: boolean
  shortname?: string
}

export interface FileListResult {
  files: FileEntry[]
  path: string
  total: number
  used: number
  occupation: number
}

export interface ESPInfo {
  version: string
  hostname: string
  authentication: boolean
  asyncMode: boolean
  wsPort: number
  wsIp: string
  axes: number
  primarySd: string
  secondarySd: string
}

export interface ControllerSettings {
  junctionDeviation?: number
  homingDirInvert?: number
  spindleMin?: number
  spindleMax?: number
  stepsPerMmX?: number
  stepsPerMmY?: number
  stepsPerMmZ?: number
  maxRateX?: number
  maxRateY?: number
  maxRateZ?: number
  accelX?: number
  accelY?: number
  accelZ?: number
  maxTravelX?: number
  maxTravelY?: number
  maxTravelZ?: number
  machineRangePositiveX?: boolean
  machineRangePositiveY?: boolean
  machineRangePositiveZ?: boolean
  machineMinX?: number
  machineMaxX?: number
  machineMinY?: number
  machineMaxY?: number
  machineMinZ?: number
  machineMaxZ?: number
  hasMist?: boolean
  hasFlood?: boolean
}

export interface FluidNCSetting {
  F?: string  // 'nvs' | 'tree'
  P: string
  T: string
  V: string
  H: string
  M?: string
  S?: string
  O?: Array<Record<string, number>>
}

export interface Macro {
  id: string
  label: string
  command: string
  color: 'default' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'purple' | 'teal'
  filename?: string
  target?: 'SD' | 'ESP'
  glyph?: string
  pinned?: boolean
}

export type SidebarTab = 'files' | 'macros' | 'plugins'

export type PluginLayout = 'default' | 'workspace' | 'controls' | 'full' | 'jog'
export type ActiveLayout = 'mobile' | 'tablet' | 'desktop'

export interface PluginManifest {
  name: string
  description?: string
  icon?: string
  version?: string
  entry?: string
  files?: string[]
  layout?: PluginLayout
  layoutTablet?: PluginLayout
  layoutMobile?: PluginLayout
}

export function getEffectiveLayout(manifest: PluginManifest, activeLayout: ActiveLayout): PluginLayout {
  if (activeLayout === 'tablet' && manifest.layoutTablet) return manifest.layoutTablet
  if (activeLayout === 'mobile' && manifest.layoutMobile) return manifest.layoutMobile
  return manifest.layout ?? 'default'
}

export interface Plugin {
  id: string
  manifest: PluginManifest
  entryUrl: string
  fs: 'sd' | 'local'
}

export interface StoreEntry {
  id: string
  name: string
  description?: string
  version?: string
  author?: string
  base: string
}
export type PositionMode = 'WPos' | 'MPos' | 'Both'
export type JogStep = 0.001 | 0.01 | 0.1 | 1 | 10 | 100
export type Units = 'mm' | 'in'
export type LayoutMode = 'auto' | 'tablet' | 'desktop'
