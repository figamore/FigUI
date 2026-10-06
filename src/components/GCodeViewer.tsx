import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { Eye, Axis3D, Maximize2, Crosshair, Navigation, Play, Pause, Square, CloudDrizzle, Waves, PowerOff, Box, Zap, Orbit, Hand, ListStart, RotateCcw, FilePlus, X, AlertTriangle, Maximize, ChevronDown, Wrench } from 'lucide-react'
import { MOVE_FEED, MOVE_RAPID, type GCodeModel, type Segment, type SegmentTable } from '../lib/gcode'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { sendRaw, sendRealtime, STATUS_POLL_INTERVAL_MS } from '../lib/ws'
import type { ControllerSettings, MachineStatus, Units } from '../types'
import { displayToMm, feedUnitLabel, linearUnitLabel, mmToDisplay } from '../lib/units'
import { buildJobTimingEstimate, formatRuntime, useJobRuntimeEstimate, type JobTimingEstimate } from '../lib/jobRuntime'
import { createRenderer, renderLines, setStaticLineData, type WebGLRenderer, type Camera, type Vector3 } from '../lib/webgl'
import { addSegmentToPath, buildRenderLines, buildStatic2DPaths, buildStatic3DGeometry, clamp01, EMPTY_UINT8, getArcGeometry, normalizeAngle, type RenderLines } from '../lib/gcodeBuild'
import { RestartFromLineDialog } from './RestartFromLineDialog'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { GCODE_ACCEPT_ATTRIBUTE, isGCodeFileName } from '../lib/gcodeFiles'
import { buildFramingGCode, getFramingRequiredTravelZ, type FramingMode } from '../lib/gcodeOutline'

const GCODE_EXTENSIONS_PREVIEW = '.g, .nc, .gcode, .ngc, .tap, or .cnc'

const RAPID_COLOR     = 'rgba(110,140,220,0.65)'
const TRAVERSE_COLOR  = 'rgba(90,185,90,0.6)'
const CUT_COLOR_FG    = '#f0a030'
const CUT_DONE      = '#22c55e'
const ORIGIN_COLOR  = 'rgba(240,160,48,0.6)'
const GRID_COLOR    = 'rgba(128,128,128,0.12)'
const GRID_TEXT      = 'rgba(128,128,128,0.5)'
const TOOL_COLOR    = '#ef4444'
const TOOL_GLOW     = 'rgba(239,68,68,0.25)'
const AXIS_X_COLOR  = '#ef4444'
const AXIS_Y_COLOR  = '#22c55e'
const AXIS_Z_COLOR  = '#60a5fa'
const BED_COLOR     = 'rgba(100,180,255,0.35)'
const TOOL_PATH_COLORS = ['#f0a030', '#33adde', '#db70c7', '#47c77a', '#f56252', '#9e85f5', '#e0c23d', '#5cc7bd'] as const
const TOOL_PATH_COLOR_RGBA = [
  [0.94, 0.63, 0.19, 1.0],
  [0.20, 0.68, 0.90, 1.0],
  [0.86, 0.44, 0.78, 1.0],
  [0.28, 0.78, 0.48, 1.0],
  [0.96, 0.38, 0.32, 1.0],
  [0.62, 0.52, 0.96, 1.0],
  [0.88, 0.76, 0.24, 1.0],
  [0.36, 0.78, 0.74, 1.0],
] as const

interface Transform {
  ox: number
  oy: number
  scale: number
}

interface BedEnvelope {
  originX: number
  originY: number
  width: number
  height: number
}

interface ToolpathProgress {
  segmentIndex: number
  fraction: number
  misses?: number
}

type SimulationPhase = 'idle' | 'playing' | 'paused' | 'completed'

interface OrbitState {
  theta: number
  phi: number
  radius: number
  orthoSize: number
  target: Vector3
}

type ProjectionMode = 'perspective' | 'orthographic'
type DragMode = 'orbit' | 'pan'

interface ScreenAnchor {
  ndcX: number
  ndcY: number
  aspect: number
}

interface AxisIndicatorVector {
  label: 'X' | 'Y' | 'Z'
  color: string
  start: { x: number; y: number }
  end: { x: number; y: number }
  labelPosition: { x: number; y: number }
  depth: number
}

interface CubeFaceData {
  label: string
  depth: number
  projectedCorners: Array<{ x: number; y: number }>
  projectedCenter: { x: number; y: number }
  labelTransform: string
  isVisible: boolean
  snapTheta: number
  snapPhi: number
}

interface CubeCornerFacetData {
  label: string
  depth: number
  projectedCorners: Array<{ x: number; y: number }>
  isVisible: boolean
  snapTheta: number
  snapPhi: number
}

interface ViewCubeData {
  faces: CubeFaceData[]
  cornerFacets: CubeCornerFacetData[]
  axisVectors: AxisIndicatorVector[]
  axisOrigin: { x: number; y: number }
}

const TAU = Math.PI * 2
const INITIAL_LOCK_TOLERANCE_MM = 0.25
const FOLLOW_TOLERANCE_MM = 0.2
const ENDPOINT_TOLERANCE_MM = 0.2
const SEGMENT_LOOKAHEAD = 12
const LOOKAHEAD_DISTANCE_FLOOR_MM = 1
const LOOKAHEAD_FEED_MARGIN = 3
const LOOKAHEAD_MAX_SEGMENTS = 4000
const LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT = 100_000
/** Above this many lines, 2D pan and zoom stretch the cached layer until the view settles. */
const LARGE_2D_LAYER_LINE_LIMIT = 100_000
const STATIC_2D_SETTLE_MS = 150
const FOLLOW_EDGE_MARGIN_PX = 40
const FOLLOW_EDGE_MARGIN_RATIO = 0.1
const EMPTY_FLOAT32 = new Float32Array(0)
const WHEEL_ZOOM_SENSITIVITY = 0.0012
const ORBIT_ROTATIONS_PER_VIEWPORT = 1
const ORBIT_POLAR_EPSILON = 0.001
const VIEW_FIT_PADDING = 1.15
const CAMERA_CLIP_NEAR_MIN = 0.001
const CAMERA_CLIP_PADDING_RATIO = 0.05
const CAMERA_CLIP_PADDING_MIN = 0.5
const ENTRY_EXIT_CONE_HEIGHT = 1.6
const ENTRY_EXIT_CONE_RADIUS = 0.65
const TOOLHEAD_CONE_HEIGHT = 5
const TOOLHEAD_CONE_RADIUS = 0.85
const TOOLHEAD_TIP_CROSS = 0.35
const TOOLHEAD_TIP_STEM = 1.25
const LOCAL_SENDER_WARNING_ACK_KEY = 'gcode.localSenderWarningAcknowledged'
const FRAMING_MODE_KEY = 'gcode.framingMode'
const FRAMING_FEED_KEY = 'gcode.framingFeedMmPerMin'
const FRAMING_CLEARANCE_KEY = 'gcode.framingClearanceMm'
const FRAMING_TRAVEL_Z_KEY = 'gcode.framingTravelZMm'
const SIMULATION_SPEED_MIN = 25
const SIMULATION_SPEED_MAX = 10000
const SIMULATION_SPEED_STEP = 25

const ENTRY_MARKER_LINE = [0.13, 0.77, 0.37, 1.0] as const
const ENTRY_MARKER_FILL = [0.13, 0.77, 0.37, 0.26] as const
const EXIT_MARKER_LINE = [0.94, 0.27, 0.27, 1.0] as const
const EXIT_MARKER_FILL = [0.94, 0.27, 0.27, 0.26] as const

function getAxisEnvelopeOrigin(wco: number, maxTravel: number, homingDirInvert: number, bit: number) {
  return -wco - ((homingDirInvert & bit) ? 0 : maxTravel)
}

function getAxisEnvelopeFromMachineRange(machineMin: number | undefined, machineMax: number | undefined, wco: number) {
  if (machineMin == null || machineMax == null) return null
  return {
    origin: machineMin - wco,
    size: machineMax - machineMin,
  }
}

function getBedEnvelope(settings: ControllerSettings, status: MachineStatus): BedEnvelope | null {
  const { maxTravelX, maxTravelY, homingDirInvert = 0 } = settings
  if (maxTravelX == null || maxTravelY == null) return null

  const xEnvelope = getAxisEnvelopeFromMachineRange(settings.machineMinX, settings.machineMaxX, status.wco.x)
  const yEnvelope = getAxisEnvelopeFromMachineRange(settings.machineMinY, settings.machineMaxY, status.wco.y)

  return {
    originX: xEnvelope?.origin ?? getAxisEnvelopeOrigin(status.wco.x, maxTravelX, homingDirInvert, 1),
    originY: yEnvelope?.origin ?? getAxisEnvelopeOrigin(status.wco.y, maxTravelY, homingDirInvert, 2),
    width: xEnvelope?.size ?? maxTravelX,
    height: yEnvelope?.size ?? maxTravelY,
  }
}

interface StaticPathGeometry {
  model: GCodeModel
  showRapids: boolean
  /** Tools filtered out of this geometry; null for the full toolpath. */
  hiddenTools: Set<number> | null
  vertices: Float32Array
  colors: Uint8Array
}

interface Static2DPaths {
  model: GCodeModel
  rapidPath: Path2D
  traversePath: Path2D
  cutPath: Path2D
  toolPaths?: Array<{
    tool: number | null
    rapidPath: Path2D
    traversePath: Path2D
    cutPath: Path2D
  }>
}

/** The static toolpath stroked once into an offscreen canvas for a given view. */
interface Static2DLayer {
  paths: Static2DPaths
  canvas: HTMLCanvasElement
  ox: number
  oy: number
  scale: number
  w: number
  h: number
  dpr: number
  showRapids: boolean
  hiddenTools: Set<number>
  /** Set once panning or zooming pauses, so the next render strokes it sharply again. */
  settled: boolean
}

interface Progress2DPath {
  model: GCodeModel
  path: Path2D
  lastCompletedSegment: number
}

interface MarkerPoint {
  x: number
  y: number
  z: number
}

interface MarkerGeometry {
  model: GCodeModel
  vertices: Float32Array
  colors: Float32Array
  triangleVertices: Float32Array
  triangleColors: Float32Array
}

function getRapidMarkerPoint(seg: Segment) {
  return seg.z0 >= seg.z1
    ? { x: seg.x0, y: seg.y0, z: seg.z0 }
    : { x: seg.x1, y: seg.y1, z: seg.z1 }
}

function segmentAt(segments: SegmentTable, index: number): Segment | undefined {
  return index >= 0 && index < segments.length ? segments.get(index) : undefined
}

function findEntryExitMarkerPoints(segments: SegmentTable) {
  let firstCutIndex = -1
  let lastCutIndex = -1

  for (let index = 0; index < segments.length; index++) {
    if (segments.moveCode(index) === MOVE_FEED) {
      firstCutIndex = index
      break
    }
  }

  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments.moveCode(index) === MOVE_FEED) {
      lastCutIndex = index
      break
    }
  }

  if (firstCutIndex < 0 || lastCutIndex < 0) {
    return { entry: null, exit: null }
  }

  const entryRapid = firstCutIndex > 0 && segments.moveCode(firstCutIndex - 1) === MOVE_RAPID
    ? segments.get(firstCutIndex - 1)
    : null
  const exitRapid = lastCutIndex < segments.length - 1 && segments.moveCode(lastCutIndex + 1) === MOVE_RAPID
    ? segments.get(lastCutIndex + 1)
    : null

  return {
    entry: entryRapid ? getRapidMarkerPoint(entryRapid) : null,
    exit: exitRapid ? getRapidMarkerPoint(exitRapid) : null,
  }
}

function appendConeGeometry(
  vertices: number[],
  colors: number[],
  triangleVertices: number[],
  triangleColors: number[],
  point: MarkerPoint,
  height: number,
  radius: number,
  lineColor: readonly [number, number, number, number],
  fillColor: readonly [number, number, number, number],
  direction: 'up' | 'down',
  ringSegments: number,
  spokeStride = 0,
  capColor?: readonly [number, number, number, number],
) {
  const tipZ = point.z
  const baseZ = direction === 'up' ? point.z - height : point.z + height

  for (let index = 0; index < ringSegments; index++) {
    const angle1 = (index / ringSegments) * TAU
    const angle2 = ((index + 1) / ringSegments) * TAU
    const x1 = point.x + Math.cos(angle1) * radius
    const y1 = point.y + Math.sin(angle1) * radius
    const x2 = point.x + Math.cos(angle2) * radius
    const y2 = point.y + Math.sin(angle2) * radius

    triangleVertices.push(
      point.x, point.y, tipZ,
      x1, y1, baseZ,
      x2, y2, baseZ,
    )
    triangleColors.push(...fillColor, ...fillColor, ...fillColor)

    if (capColor) {
      triangleVertices.push(
        point.x, point.y, baseZ,
        x2, y2, baseZ,
        x1, y1, baseZ,
      )
      triangleColors.push(...capColor, ...capColor, ...capColor)
    }

    vertices.push(x1, y1, baseZ, x2, y2, baseZ)
    colors.push(...lineColor, ...lineColor)

    if (spokeStride > 0 && index % spokeStride === 0) {
      vertices.push(point.x, point.y, tipZ, x1, y1, baseZ)
      colors.push(...lineColor, ...lineColor)
    }
  }
}

function buildEntryExitMarkerGeometry(segments: SegmentTable) {
  if (segments.length === 0) {
    return {
      vertices: EMPTY_FLOAT32,
      colors: EMPTY_FLOAT32,
      triangleVertices: EMPTY_FLOAT32,
      triangleColors: EMPTY_FLOAT32,
    }
  }

  const { entry, exit } = findEntryExitMarkerPoints(segments)
  if (!entry && !exit) {
    return {
      vertices: EMPTY_FLOAT32,
      colors: EMPTY_FLOAT32,
      triangleVertices: EMPTY_FLOAT32,
      triangleColors: EMPTY_FLOAT32,
    }
  }

  const vertices: number[] = []
  const colors: number[] = []
  const triangleVertices: number[] = []
  const triangleColors: number[] = []

  if (entry) {
    appendConeGeometry(vertices, colors, triangleVertices, triangleColors, entry, ENTRY_EXIT_CONE_HEIGHT, ENTRY_EXIT_CONE_RADIUS, ENTRY_MARKER_LINE, ENTRY_MARKER_FILL, 'down', 18, 3)
  }
  if (exit) {
    appendConeGeometry(vertices, colors, triangleVertices, triangleColors, exit, ENTRY_EXIT_CONE_HEIGHT, ENTRY_EXIT_CONE_RADIUS, EXIT_MARKER_LINE, EXIT_MARKER_FILL, 'up', 18, 3)
  }

  return {
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    triangleVertices: new Float32Array(triangleVertices),
    triangleColors: new Float32Array(triangleColors),
  }
}

function mergeFloat32Arrays(...arrays: Float32Array[]) {
  const nonEmpty = arrays.filter(array => array.length > 0)
  if (nonEmpty.length === 0) return EMPTY_FLOAT32
  if (nonEmpty.length === 1) return nonEmpty[0]

  const merged = new Float32Array(nonEmpty.reduce((total, array) => total + array.length, 0))
  let offset = 0
  for (const array of nonEmpty) {
    merged.set(array, offset)
    offset += array.length
  }
  return merged
}


function buildBedLineGeometry(bedW: number, bedH: number, ox: number, oy: number): { vertices: Float32Array, colors: Float32Array } {
  const x0 = ox, y0 = oy, x1 = ox + bedW, y1 = oy + bedH
  const corners = [
    [x0, y0, 0], [x1, y0, 0],
    [x1, y0, 0], [x1, y1, 0],
    [x1, y1, 0], [x0, y1, 0],
    [x0, y1, 0], [x0, y0, 0],
  ]
  const vertices = new Float32Array(corners.flat())
  const c = [0.27, 0.60, 1.0, 0.85]
  const colorData: number[] = []
  for (let i = 0; i < corners.length; i++) colorData.push(...c)
  return { vertices, colors: new Float32Array(colorData) }
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  seg: Segment,
  t: Transform,
  fraction = 1,
) {
  const clampedFraction = clamp01(fraction)
  if (clampedFraction <= 0) return

  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    const sx = t.ox + arc.cx * t.scale
    const sy = t.oy - arc.cy * t.scale
    const startAngle = arc.startAngle
    const endAngle = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * clampedFraction

    ctx.beginPath()
    if (arc.fullCircle && clampedFraction >= 0.999999) {
      ctx.arc(sx, sy, arc.r * t.scale, 0, TAU)
    } else {
      ctx.arc(sx, sy, arc.r * t.scale, -startAngle, -endAngle, !seg.cw)
    }
    ctx.stroke()

    if (arc.r * t.scale < 2) {
      ctx.beginPath()
      ctx.moveTo(t.ox + seg.x0 * t.scale, t.oy - seg.y0 * t.scale)
      ctx.lineTo(t.ox + seg.x1 * t.scale, t.oy - seg.y1 * t.scale)
      ctx.stroke()
    }
    return
  }

  const x = seg.x0 + (seg.x1 - seg.x0) * clampedFraction
  const y = seg.y0 + (seg.y1 - seg.y0) * clampedFraction
  ctx.beginPath()
  ctx.moveTo(t.ox + seg.x0 * t.scale, t.oy - seg.y0 * t.scale)
  ctx.lineTo(t.ox + x * t.scale, t.oy - y * t.scale)
  ctx.stroke()
}

function strokeModelPath(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  t: Transform,
  strokeStyle: string,
  lineWidthPx: number,
  lineDashPx: number[] = [],
) {
  const safeScale = Math.max(t.scale, 1e-6)
  ctx.save()
  ctx.translate(t.ox, t.oy)
  ctx.scale(safeScale, -safeScale)
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidthPx / safeScale
  ctx.setLineDash(lineDashPx.map(value => value / safeScale))
  ctx.stroke(path)
  ctx.restore()
}

function strokeStatic2DPaths(
  ctx: CanvasRenderingContext2D,
  paths: Static2DPaths,
  t: Transform,
  showRapids: boolean,
  hiddenTools: Set<number>,
) {
  if (paths.toolPaths?.length) {
    for (const toolPaths of paths.toolPaths) {
      if (toolPaths.tool != null && hiddenTools.has(toolPaths.tool)) continue
      strokeModelPath(ctx, toolPaths.cutPath, t, toolPathColor(toolPaths.tool), 1)
      if (showRapids) {
        strokeModelPath(ctx, toolPaths.traversePath, t, TRAVERSE_COLOR, 0.5, [2, 2])
        strokeModelPath(ctx, toolPaths.rapidPath, t, RAPID_COLOR, 0.5, [4, 3])
      }
    }
    return
  }
  strokeModelPath(ctx, paths.cutPath, t, CUT_COLOR_FG, 1)
  if (showRapids) {
    strokeModelPath(ctx, paths.traversePath, t, TRAVERSE_COLOR, 0.5, [2, 2])
    strokeModelPath(ctx, paths.rapidPath, t, RAPID_COLOR, 0.5, [4, 3])
  }
}

function toolPathColor(tool: number | null | undefined) {
  if (tool == null) return CUT_COLOR_FG
  const abs = Math.abs(tool)
  return TOOL_PATH_COLORS[(abs > 0 ? abs - 1 : 0) % TOOL_PATH_COLORS.length]
}

function toolPathColorRgba(tool: number | null | undefined) {
  if (tool == null) return TOOL_PATH_COLOR_RGBA[0]
  const abs = Math.abs(tool)
  return TOOL_PATH_COLOR_RGBA[(abs > 0 ? abs - 1 : 0) % TOOL_PATH_COLOR_RGBA.length]
}

function measureProgressAlongSegment(seg: Segment, px: number, py: number, pz: number) {
  if (seg.i === undefined) {
    const dx = seg.x1 - seg.x0
    const dy = seg.y1 - seg.y0
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-9) {
      const distSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2 + (pz - seg.z0) ** 2
      return { fraction: 0, distanceSq: distSq }
    }
    const rawFraction = ((px - seg.x0) * dx + (py - seg.y0) * dy) / lenSq
    const fraction = clamp01(rawFraction)
    const projX = seg.x0 + dx * fraction
    const projY = seg.y0 + dy * fraction
    const projZ = seg.z0 + (seg.z1 - seg.z0) * fraction
    const distanceSq = (px - projX) ** 2 + (py - projY) ** 2 + (pz - projZ) ** 2
    return { fraction, distanceSq }
  }

  const arc = getArcGeometry(seg)
  if (arc.r < 1e-9) {
    const distSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2 + (pz - seg.z0) ** 2
    return { fraction: 0, distanceSq: distSq }
  }

  const pointAngle = Math.atan2(py - arc.cy, px - arc.cx)
  const delta = seg.cw
    ? normalizeAngle(arc.startAngle - pointAngle)
    : normalizeAngle(pointAngle - arc.startAngle)

  if (arc.fullCircle || delta <= arc.sweep + 1e-6) {
    const fraction = arc.fullCircle ? clamp01(delta / arc.sweep) : clamp01(delta / arc.sweep)
    const projX = arc.cx + Math.cos(pointAngle) * arc.r
    const projY = arc.cy + Math.sin(pointAngle) * arc.r
    const projZ = seg.z0 + (seg.z1 - seg.z0) * fraction
    const distanceSq = (px - projX) ** 2 + (py - projY) ** 2 + (pz - projZ) ** 2
    return { fraction, distanceSq }
  }

  const startDistSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2 + (pz - seg.z0) ** 2
  const endDistSq = (px - seg.x1) ** 2 + (py - seg.y1) ** 2 + (pz - seg.z1) ** 2
  return startDistSq <= endDistSq
    ? { fraction: 0, distanceSq: startDistSq }
    : { fraction: 1, distanceSq: endDistSq }
}

function compareProgress(a: ToolpathProgress, b: ToolpathProgress) {
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
  return a.fraction - b.fraction
}

function pointDistanceSq(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  return (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2
}

function normalizeVector(x: number, y: number, z: number) {
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
}

function crossProduct(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function scaleVector(v: { x: number; y: number; z: number }, scalar: number) {
  return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar }
}

function addVectors(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function subtractVectors(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dotProduct(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function getOrbitCameraPosition(orbit: OrbitState) {
  return {
    x: orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    y: orbit.target.y + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    z: orbit.target.z + orbit.radius * Math.cos(orbit.phi),
  }
}

function getOrbitCameraBasis(orbit: OrbitState, up: Vector3) {
  const position = getOrbitCameraPosition(orbit)
  const forward = normalizeVector(
    orbit.target.x - position.x,
    orbit.target.y - position.y,
    orbit.target.z - position.z,
  )
  const right = normalizeVector(...Object.values(crossProduct(forward, up)) as [number, number, number])
  const screenUp = normalizeVector(...Object.values(crossProduct(right, forward)) as [number, number, number])
  return { forward, right, screenUp }
}

function getBoundsCorners(bounds: GCodeModel['bounds']) {
  return [
    { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
    { x: bounds.minX, y: bounds.minY, z: bounds.maxZ },
    { x: bounds.minX, y: bounds.maxY, z: bounds.minZ },
    { x: bounds.minX, y: bounds.maxY, z: bounds.maxZ },
    { x: bounds.maxX, y: bounds.minY, z: bounds.minZ },
    { x: bounds.maxX, y: bounds.minY, z: bounds.maxZ },
    { x: bounds.maxX, y: bounds.maxY, z: bounds.minZ },
    { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
  ]
}

function getClipBounds(modelBounds: GCodeModel['bounds'] | null) {
  const store = useMachineStore.getState()

  let minX = modelBounds ? modelBounds.minX : Infinity
  let minY = modelBounds ? modelBounds.minY : Infinity
  let minZ = modelBounds ? modelBounds.minZ : Infinity
  let maxX = modelBounds ? modelBounds.maxX : -Infinity
  let maxY = modelBounds ? modelBounds.maxY : -Infinity
  let maxZ = modelBounds ? modelBounds.maxZ : -Infinity

  const bed = getBedEnvelope(store.controllerSettings, store.status)
  if (bed) {
    const bedMaxX = bed.originX + bed.width
    const bedMaxY = bed.originY + bed.height

    minX = Math.min(minX, bed.originX, bedMaxX)
    minY = Math.min(minY, bed.originY, bedMaxY)
    minZ = Math.min(minZ, 0)
    maxX = Math.max(maxX, bed.originX, bedMaxX)
    maxY = Math.max(maxY, bed.originY, bedMaxY)
    maxZ = Math.max(maxZ, 0)
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY) || !isFinite(minZ) || !isFinite(maxZ)) {
    return { minX: -100, minY: -100, minZ: 0, maxX: 100, maxY: 100, maxZ: 0 }
  }

  return { minX, minY, minZ, maxX, maxY, maxZ }
}


const HALF_PI = Math.PI / 2
const ISOMETRIC_PHI = Math.acos(1 / Math.sqrt(3))
const VIEW_CUBE_CHAMFER = 0.34
const VIEW_CUBE_AXIS_EXTENSION = 0.36

function get3DViewCubeData(orbit: OrbitState, up: Vector3, cx: number, cy: number, s: number): ViewCubeData {
  const { forward, right, screenUp } = getOrbitCameraBasis(orbit, up)

  function project(v: { x: number; y: number; z: number }) {
    return {
      x: cx + dotProduct(v, right) * s,
      y: cy - dotProduct(v, screenUp) * s,
    }
  }

  const faceDefs: Array<{
    label: string
    n: { x: number; y: number; z: number }
    corners: Array<{ x: number; y: number; z: number }>
    snapTheta: number
    snapPhi: number
  }> = [
    {
      label: 'Top', n: { x: 0, y: 0, z: 1 },
      corners: [{ x: 1, y: 1, z: 1 }, { x: -1, y: 1, z: 1 }, { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 }],
      // Keep the world axes upright rather than carrying over the last orbit's roll.
      snapTheta: -HALF_PI, snapPhi: 0.02,
    },
    {
      label: 'Bottom', n: { x: 0, y: 0, z: -1 },
      corners: [{ x: 1, y: -1, z: -1 }, { x: -1, y: -1, z: -1 }, { x: -1, y: 1, z: -1 }, { x: 1, y: 1, z: -1 }],
      snapTheta: HALF_PI, snapPhi: Math.PI - 0.02,
    },
    {
      label: 'Front', n: { x: 0, y: -1, z: 0 },
      corners: [{ x: 1, y: -1, z: 1 }, { x: -1, y: -1, z: 1 }, { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 }],
      snapTheta: -HALF_PI, snapPhi: HALF_PI,
    },
    {
      label: 'Back', n: { x: 0, y: 1, z: 0 },
      corners: [{ x: -1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: -1 }, { x: -1, y: 1, z: -1 }],
      snapTheta: HALF_PI, snapPhi: HALF_PI,
    },
    {
      label: 'Right', n: { x: 1, y: 0, z: 0 },
      corners: [{ x: 1, y: 1, z: 1 }, { x: 1, y: -1, z: 1 }, { x: 1, y: -1, z: -1 }, { x: 1, y: 1, z: -1 }],
      snapTheta: 0, snapPhi: HALF_PI,
    },
    {
      label: 'Left', n: { x: -1, y: 0, z: 0 },
      corners: [{ x: -1, y: -1, z: 1 }, { x: -1, y: 1, z: 1 }, { x: -1, y: 1, z: -1 }, { x: -1, y: -1, z: -1 }],
      snapTheta: Math.PI, snapPhi: HALF_PI,
    },
  ]

  const faces: CubeFaceData[] = faceDefs.map(def => {
    const depth = dotProduct(def.n, forward)
    const projectedCorners = def.corners.flatMap((corner, index, allCorners) => {
      const previous = allCorners[(index + allCorners.length - 1) % allCorners.length]
      const next = allCorners[(index + 1) % allCorners.length]
      return [previous, next].map(neighbor => project({
        x: corner.x + (neighbor.x - corner.x) * VIEW_CUBE_CHAMFER,
        y: corner.y + (neighbor.y - corner.y) * VIEW_CUBE_CHAMFER,
        z: corner.z + (neighbor.z - corner.z) * VIEW_CUBE_CHAMFER,
      }))
    })
    const labelCorners = def.corners.map(project)
    const projectedCenter = project(def.n)
    const labelXAxis = {
      x: ((labelCorners[0].x - labelCorners[1].x) + (labelCorners[3].x - labelCorners[2].x)) / 4,
      y: ((labelCorners[0].y - labelCorners[1].y) + (labelCorners[3].y - labelCorners[2].y)) / 4,
    }
    const labelYAxis = {
      x: ((labelCorners[2].x - labelCorners[1].x) + (labelCorners[3].x - labelCorners[0].x)) / 4,
      y: ((labelCorners[2].y - labelCorners[1].y) + (labelCorners[3].y - labelCorners[0].y)) / 4,
    }

    return {
      label: def.label,
      depth,
      projectedCorners,
      projectedCenter,
      labelTransform: `matrix(${labelXAxis.x} ${labelXAxis.y} ${labelYAxis.x} ${labelYAxis.y} ${projectedCenter.x} ${projectedCenter.y})`,
      isVisible: depth < -0.05,
      snapTheta: def.snapTheta,
      snapPhi: def.snapPhi,
    }
  }).sort((a, b) => b.depth - a.depth)

  // Each actual chamfer plane is an isometric-view target, so there is no
  // separate control layer competing with the cube itself.
  const projectedCorners = [
    { x: -1, y: -1, z: -1 }, { x: -1, y: -1, z: 1 },
    { x: -1, y: 1, z: -1 }, { x: -1, y: 1, z: 1 },
    { x: 1, y: -1, z: -1 }, { x: 1, y: -1, z: 1 },
    { x: 1, y: 1, z: -1 }, { x: 1, y: 1, z: 1 },
  ]
    .map(corner => {
      const facetCorners = [
        { x: corner.x * (1 - VIEW_CUBE_CHAMFER), y: corner.y, z: corner.z },
        { x: corner.x, y: corner.y * (1 - VIEW_CUBE_CHAMFER), z: corner.z },
        { x: corner.x, y: corner.y, z: corner.z * (1 - VIEW_CUBE_CHAMFER) },
      ]
      return {
        corner,
        depth: dotProduct(corner, forward),
        facetCorners: facetCorners.map(project),
      }
    })

  const cornerFacets: CubeCornerFacetData[] = projectedCorners
    .map(corner => ({
      label: `${corner.corner.x > 0 ? '+X' : '-X'} ${corner.corner.y > 0 ? '+Y' : '-Y'} ${corner.corner.z > 0 ? '+Z' : '-Z'}`,
      depth: corner.depth,
      projectedCorners: corner.facetCorners,
      // Include silhouette facets, but exclude back-facing planes.
      isVisible: corner.depth < 0.05,
      snapTheta: Math.atan2(corner.corner.y, corner.corner.x),
      snapPhi: corner.corner.z > 0 ? ISOMETRIC_PHI : Math.PI - ISOMETRIC_PHI,
    }))
    .sort((a, b) => b.depth - a.depth)

  const axisOrigin3D = { x: -1, y: -1, z: -1 }
  const axisOrigin = project(axisOrigin3D)
  const axisEdgeDefs: Array<{
    label: 'X' | 'Y' | 'Z'
    color: string
    end: { x: number; y: number; z: number }
  }> = [
    { label: 'X', color: AXIS_X_COLOR, end: { x: 1 + VIEW_CUBE_AXIS_EXTENSION, y: -1, z: -1 } },
    { label: 'Y', color: AXIS_Y_COLOR, end: { x: -1, y: 1 + VIEW_CUBE_AXIS_EXTENSION, z: -1 } },
    { label: 'Z', color: AXIS_Z_COLOR, end: { x: -1, y: -1, z: 1 + VIEW_CUBE_AXIS_EXTENSION } },
  ]

  const axisVectors = axisEdgeDefs.map(axis => {
    const end = project(axis.end)
    const dx = end.x - axisOrigin.x
    const dy = end.y - axisOrigin.y
    const len = Math.hypot(dx, dy) || 1
    const labelOffset = 8

    return {
      label: axis.label,
      color: axis.color,
      start: axisOrigin,
      end,
      labelPosition: {
        x: end.x + (dx / len) * labelOffset,
        y: end.y + (dy / len) * labelOffset,
      },
      depth: dotProduct(axis.end, forward),
    }
  }).sort((a, b) => a.depth - b.depth)

  return { faces, cornerFacets, axisVectors, axisOrigin }
}

function getArrowHeadPoints(startX: number, startY: number, endX: number, endY: number, size: number) {
  const dx = endX - startX
  const dy = endY - startY
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const baseX = endX - ux * size
  const baseY = endY - uy * size
  const perpX = -uy
  const perpY = ux
  const wing = size * 0.7
  return `${endX},${endY} ${baseX + perpX * wing},${baseY + perpY * wing} ${baseX - perpX * wing},${baseY - perpY * wing}`
}

function getWheelZoomScale(deltaY: number, deltaMode: number, pageSize: number) {
  const unit = deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(pageSize, 1)
      : 1
  const deltaPixels = Math.max(-240, Math.min(240, deltaY * unit))
  return Math.exp(-deltaPixels * WHEEL_ZOOM_SENSITIVITY)
}

function findNearbyProgress(
  segments: SegmentTable,
  px: number,
  py: number,
  pz: number,
  startIndex: number,
  endIndex: number,
  toleranceSq: number,
  previous: ToolpathProgress | null,
  preferLatest: boolean,
): ToolpathProgress | null {
  let best: (ToolpathProgress & { distanceSq: number }) | null = null

  for (let i = startIndex; i <= endIndex && i < segments.length; i++) {
    const measurement = measureProgressAlongSegment(segments.get(i), px, py, pz)
    const candidate: ToolpathProgress & { distanceSq: number } = {
      segmentIndex: i,
      fraction: measurement.fraction,
      distanceSq: measurement.distanceSq,
    }

    if (previous && i === previous.segmentIndex && candidate.fraction < previous.fraction) {
      candidate.fraction = previous.fraction
    }

    if (candidate.distanceSq > toleranceSq) continue

    if (
      !best
      || (preferLatest && (
        compareProgress(candidate, best) > 0
        || (compareProgress(candidate, best) === 0 && candidate.distanceSq < best.distanceSq)
      ))
      || (!preferLatest && (
        candidate.distanceSq < best.distanceSq - 1e-9
        || (Math.abs(candidate.distanceSq - best.distanceSq) <= 1e-9
          && compareProgress(candidate, best) < 0)
      ))
    ) {
      best = candidate
    }
  }

  return best ? { segmentIndex: best.segmentIndex, fraction: best.fraction } : null
}

function buildCumulativeSegmentTimes(timing: JobTimingEstimate) {
  const cumulative = new Float64Array(timing.segmentSeconds.length + 1)
  for (let i = 0; i < timing.segmentSeconds.length; i++) {
    cumulative[i + 1] = cumulative[i]
      + timing.delayBeforeSegmentSeconds[i]
      + timing.segmentSeconds[i]
  }
  cumulative[cumulative.length - 1] += timing.trailingDelaySeconds
  return cumulative
}

function getSimulationProgressAt(
  timing: JobTimingEstimate,
  cumulative: Float64Array,
  elapsedSeconds: number,
): ToolpathProgress | null {
  if (timing.segmentSeconds.length === 0 || timing.totalSeconds <= 0) return null
  const clampedElapsed = Math.max(0, Math.min(elapsedSeconds, timing.totalSeconds))
  let low = 0
  let high = timing.segmentSeconds.length - 1

  // Find the first segment whose end time reaches the requested time. This
  // replaces the per-frame scan from the beginning of the whole program.
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (cumulative[mid + 1] >= clampedElapsed) high = mid
    else low = mid + 1
  }

  let segmentIndex = low
  while (segmentIndex < timing.segmentSeconds.length && timing.segmentSeconds[segmentIndex] <= 0) {
    segmentIndex++
  }
  if (segmentIndex >= timing.segmentSeconds.length) {
    segmentIndex = timing.segmentSeconds.length - 1
    while (segmentIndex >= 0 && timing.segmentSeconds[segmentIndex] <= 0) segmentIndex--
  }
  if (segmentIndex < 0) return null

  const seconds = timing.segmentSeconds[segmentIndex]
  return {
    segmentIndex,
    fraction: clamp01((clampedElapsed
      - cumulative[segmentIndex]
      - timing.delayBeforeSegmentSeconds[segmentIndex]) / seconds),
  }
}

function getSegmentPoint(seg: Segment, fraction: number) {
  const t = clamp01(fraction)
  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    const angle = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t
    return {
      x: arc.cx + Math.cos(angle) * arc.r,
      y: arc.cy + Math.sin(angle) * arc.r,
      z: seg.z0 + (seg.z1 - seg.z0) * t,
    }
  }
  return {
    x: seg.x0 + (seg.x1 - seg.x0) * t,
    y: seg.y0 + (seg.y1 - seg.y0) * t,
    z: seg.z0 + (seg.z1 - seg.z0) * t,
  }
}

function segmentXYLength(seg: Segment) {
  if (seg.i !== undefined && (seg.arcPlane ?? 17) === 17) {
    const arc = getArcGeometry(seg)
    return Math.hypot(arc.sweep * arc.r, seg.z1 - seg.z0)
  }
  return Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0, seg.z1 - seg.z0)
}

function buildCumulativeXYLengths(segments: SegmentTable) {
  const cumulative = new Float64Array(segments.length + 1)
  for (let i = 0; i < segments.length; i++) {
    const length = segments.isArc(i)
      ? segmentXYLength(segments.get(i))
      : Math.hypot(
          segments.px[i + 1] - segments.px[i],
          segments.py[i + 1] - segments.py[i],
          segments.pz[i + 1] - segments.pz[i],
        )
    cumulative[i + 1] = cumulative[i] + length
  }
  return cumulative
}

function getLookaheadDistanceMm(feedMmPerMin: number) {
  const pollSeconds = STATUS_POLL_INTERVAL_MS / 1000
  return Math.max(LOOKAHEAD_DISTANCE_FLOOR_MM, (feedMmPerMin / 60) * pollSeconds * LOOKAHEAD_FEED_MARGIN)
}

function findToolpathProgress(
  segments: SegmentTable,
  cumulativeXYLengths: Float64Array,
  px: number,
  py: number,
  pz: number,
  previous: ToolpathProgress | null,
  lookaheadDistanceMm: number,
  maxSegmentIndex = segments.length - 1,
): ToolpathProgress | null {
  const allowedEndIndex = Math.min(maxSegmentIndex, segments.length - 1)
  if (segments.length === 0 || allowedEndIndex < 0) return null

  if (!previous) {
    return findNearbyProgress(
      segments,
      px,
      py,
      pz,
      0,
      allowedEndIndex,
      INITIAL_LOCK_TOLERANCE_MM ** 2,
      null,
      false,
    )
  }

  const startIndex = previous.segmentIndex
  const maxEndIndex = Math.min(startIndex + LOOKAHEAD_MAX_SEGMENTS, allowedEndIndex)
  const nearEndIndex = Math.min(startIndex + SEGMENT_LOOKAHEAD, allowedEndIndex)

  const near = findNearbyProgress(
    segments,
    px,
    py,
    pz,
    startIndex,
    nearEndIndex,
    FOLLOW_TOLERANCE_MM ** 2,
    previous,
    false,
  )
  if (near) return { ...near, misses: 0 }

  const priorMisses = previous.misses ?? 0
  const distanceLimit = cumulativeXYLengths[startIndex] + lookaheadDistanceMm * (priorMisses + 1)
  let farEndIndex = nearEndIndex
  while (farEndIndex < maxEndIndex && cumulativeXYLengths[farEndIndex + 1] < distanceLimit) farEndIndex++

  if (farEndIndex > nearEndIndex) {
    const far = findNearbyProgress(
      segments,
      px,
      py,
      pz,
      nearEndIndex + 1,
      farEndIndex,
      FOLLOW_TOLERANCE_MM ** 2,
      previous,
      false,
    )
    if (far) return { ...far, misses: 0 }
  }

  const current = segments.get(startIndex)
  if (pointDistanceSq(px, py, pz, current.x1, current.y1, current.z1) <= ENDPOINT_TOLERANCE_MM ** 2) {
    return { segmentIndex: startIndex, fraction: 1, misses: 0 }
  }

  return { ...previous, misses: priorMisses + 1 }
}

function findLastSegmentAtOrBeforeSourceLine(segments: SegmentTable, sourceLine: number) {
  let low = 0
  let high = segments.length - 1
  let result = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (segments.sourceLine(middle) <= sourceLine) {
      result = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, t: Transform, units: Units) {
  const mmPerPx = 1 / t.scale
  const displayPerPx = mmToDisplay(mmPerPx, units)
  const rawSpacing = 80 * displayPerPx
  const mag = Math.pow(10, Math.floor(Math.log10(rawSpacing)))
  let displaySpacing = mag
  if (rawSpacing / mag > 5) displaySpacing = mag * 10
  else if (rawSpacing / mag > 2) displaySpacing = mag * 5
  else if (rawSpacing / mag > 1) displaySpacing = mag * 2

  const spacingMm = displayToMm(displaySpacing, units)
  const pxSpacing = spacingMm * t.scale

  ctx.strokeStyle = GRID_COLOR
  ctx.lineWidth = 1
  ctx.font = '10px ui-monospace, monospace'
  ctx.fillStyle = GRID_TEXT
  ctx.textBaseline = 'top'

  const startX = Math.floor(-t.ox / pxSpacing) * pxSpacing
  for (let px = startX + (t.ox % pxSpacing + pxSpacing) % pxSpacing; px < w; px += pxSpacing) {
    const mmVal = (px - t.ox) / t.scale
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
    ctx.fillText(fmtNum(mmVal, units), px + 3, 3)
  }

  ctx.textBaseline = 'bottom'
  const startY = Math.floor(-t.oy / pxSpacing) * pxSpacing
  for (let py = startY + (t.oy % pxSpacing + pxSpacing) % pxSpacing; py < h; py += pxSpacing) {
    const mmVal = -(py - t.oy) / t.scale
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(w, py)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.fillText(fmtNum(mmVal, units), 3, py - 2)
  }
}


function fmtNum(mmValue: number, units: Units): string {
  const value = mmToDisplay(mmValue, units)
  if (Math.abs(value) < 0.0001) return '0'
  if (units === 'in') {
    if (Math.abs(value) >= 10) return value.toFixed(value % 1 ? 1 : 0)
    if (Math.abs(value) >= 1) return value.toFixed(value % 1 ? 2 : 0)
    return value.toFixed(3)
  }
  return value.toFixed(value % 1 ? 1 : 0)
}

function getStoredFramingMode(): FramingMode {
  const value = localStorage.getItem(FRAMING_MODE_KEY)
  return value === 'contour' || value === 'rectangle' ? value : 'rectangle'
}

function getStoredPositiveNumber(key: string, fallback: number) {
  const parsed = Number.parseFloat(localStorage.getItem(key) ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getStoredFiniteNumber(key: string, fallback: number) {
  const parsed = Number.parseFloat(localStorage.getItem(key) ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatInputValue(value: number, decimals: number) {
  return value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
}

function formatCeilInputValue(value: number, decimals: number) {
  const factor = 10 ** decimals
  return formatInputValue(Math.ceil((value - Number.EPSILON) * factor) / factor, decimals)
}

function drawOrigin(ctx: CanvasRenderingContext2D, t: Transform) {
  const len = 20
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#ef4444'
  ctx.beginPath()
  ctx.moveTo(t.ox, t.oy)
  ctx.lineTo(t.ox + len, t.oy)
  ctx.stroke()
  ctx.strokeStyle = '#22c55e'
  ctx.beginPath()
  ctx.moveTo(t.ox, t.oy)
  ctx.lineTo(t.ox, t.oy - len)
  ctx.stroke()
  ctx.fillStyle = ORIGIN_COLOR
  ctx.beginPath()
  ctx.arc(t.ox, t.oy, 3, 0, Math.PI * 2)
  ctx.fill()
}

function drawBedBoundary(ctx: CanvasRenderingContext2D, t: Transform, bedW: number, bedH: number, originX: number, originY: number) {
  const sx0 = t.ox + originX * t.scale
  const sy0 = t.oy - originY * t.scale
  const sx1 = t.ox + (originX + bedW) * t.scale
  const sy1 = t.oy - (originY + bedH) * t.scale
  ctx.strokeStyle = BED_COLOR
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.strokeRect(sx0, sy1, sx1 - sx0, sy0 - sy1)
  ctx.setLineDash([])
}

function drawToolPosition(
  ctx: CanvasRenderingContext2D,
  t: Transform,
  wx: number,
  wy: number,
  isRunning: boolean,
) {
  const sx = t.ox + wx * t.scale
  const sy = t.oy - wy * t.scale

  const glowR = isRunning ? 14 : 10
  const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR)
  grad.addColorStop(0, TOOL_GLOW)
  grad.addColorStop(1, 'rgba(239,68,68,0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = TOOL_COLOR
  ctx.lineWidth = 1.5
  const arm = isRunning ? 10 : 7
  ctx.beginPath()
  ctx.moveTo(sx - arm, sy); ctx.lineTo(sx + arm, sy)
  ctx.moveTo(sx, sy - arm); ctx.lineTo(sx, sy + arm)
  ctx.stroke()

  ctx.fillStyle = TOOL_COLOR
  ctx.beginPath()
  ctx.arc(sx, sy, 3, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(sx, sy, 1.2, 0, Math.PI * 2)
  ctx.fill()
}

interface Props {
  className?: string
  isTablet?: boolean
  showOverrides?: boolean
  fitToViewSignal?: unknown
}

function ViewerOverrideControl({
  label,
  value,
  onMinus,
  onReset,
  onPlus,
}: {
  label: string
  value: number
  onMinus: () => void
  onReset: () => void
  onPlus: () => void
}) {
  const colorClass = value > 100 ? 'text-ok' : value < 100 ? 'text-warn' : 'text-accent'

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1 rounded border border-border bg-elevated/50 p-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-text-muted text-center">{label}</span>
      <div className="flex items-center gap-1">
        <button
          className="h-9 w-9 shrink-0 rounded border border-border bg-surface text-lg text-text-primary active:bg-elevated"
          onClick={onMinus}
          aria-label={`Decrease ${label.toLowerCase()} override`}
        >
          −
        </button>
        <button
          className={`h-9 flex-1 min-w-0 rounded border border-border bg-surface font-mono text-base font-semibold ${colorClass}`}
          onClick={onReset}
          title={`Reset ${label.toLowerCase()} override to 100%`}
        >
          {value}%
        </button>
        <button
          className="h-9 w-9 shrink-0 rounded border border-border bg-surface text-lg text-text-primary active:bg-elevated"
          onClick={onPlus}
          aria-label={`Increase ${label.toLowerCase()} override`}
        >
          +
        </button>
      </div>
    </div>
  )
}

export function GCodeViewer({ className, isTablet, showOverrides, fitToViewSignal }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const localFileInputRef = useRef<HTMLInputElement>(null)
  const model = useGCodeStore(s => s.model)
  const fileName = useGCodeStore(s => s.fileName)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const sourceText = useGCodeStore(s => s.sourceText)
  const restartSource = useGCodeStore(s => s.restartSource)
  const loading = useGCodeStore(s => s.loading)
  const pendingPath = useGCodeStore(s => s.pendingPath)
  const pendingFileName = useGCodeStore(s => s.pendingFileName)
  const downloadProgress = useGCodeStore(s => s.downloadProgress)
  const isProcessing2D = useGCodeStore(s => s.isProcessing2D)
  const processing2DProgress = useGCodeStore(s => s.processing2DProgress)
  const isProcessing3D = useGCodeStore(s => s.isProcessing3D)
  const processing3DProgress = useGCodeStore(s => s.processing3DProgress)
  const is3DReady = useGCodeStore(s => s.is3DReady)
  const sdUploadPath = useGCodeStore(s => s.sdUploadPath)
  const showRapids = useGCodeStore(s => s.showRapids)
  const setShowRapids = useGCodeStore(s => s.setShowRapids)
  const storePaths2D = useGCodeStore(s => s.paths2D)
  const storeGeometry3D = useGCodeStore(s => s.geometry3D)
  const storeRenderLines = useGCodeStore(s => s.renderLines)
  const loadFile = useGCodeStore(s => s.loadFile)
  const setActiveSourceLine = useGCodeStore(s => s.setActiveSourceLine)
  const modelRef = useRef<GCodeModel | null>(null)
  const staticPathGeometryRef = useRef<StaticPathGeometry | null>(null)
  const filteredPathGeometryRef = useRef<StaticPathGeometry | null>(null)
  const uploadedPathGeometryRef = useRef<{ geometry: StaticPathGeometry; renderer: WebGLRenderer } | null>(null)
  const renderLinesRef = useRef<RenderLines | null>(null)
  const static2DPathsRef = useRef<Static2DPaths | null>(null)
  const static2DLayerRef = useRef<Static2DLayer | null>(null)
  const static2DSettleTimerRef = useRef(0)
  const progress2DPathRef = useRef<Progress2DPath | null>(null)
  const markerGeometryRef = useRef<MarkerGeometry | null>(null)
  const pathXYLengthsRef = useRef<{ model: GCodeModel; cumulative: Float64Array } | null>(null)
  const [showTool, setShowTool] = useState(true)
  const [hiddenTools, setHiddenTools] = useState<Set<number>>(() => new Set())
  const [showToolPathMenu, setShowToolPathMenu] = useState(false)
  const [fileDragStatus, setFileDragStatus] = useState<'idle' | 'valid' | 'invalid' | 'unknown'>('idle')
  const [senderExecutionProgressPercent, setSenderExecutionProgressPercent] = useState<number | null>(null)
  const showRapidsRef = useRef(true)
  const showToolRef = useRef(true)
  const hiddenToolsRef = useRef<Set<number>>(new Set())
  const transformRef = useRef<Transform>({ ox: 0, oy: 0, scale: 1 })
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const activePointersRef = useRef<Map<number, { x: number; y: number; dragMode: DragMode }>>(new Map())
  const lastPinchDistRef = useRef<number | null>(null)
  const animRef = useRef(0)
  const renderRef = useRef<() => void>(() => {})
  const needsFitRef = useRef(true)
  const progressRef = useRef<ToolpathProgress | null>(null)
  const simulationFrameRef = useRef(0)
  const simulationPhaseRef = useRef<SimulationPhase>('idle')
  const simulationTimingRef = useRef<JobTimingEstimate | null>(null)
  const simulationCumulativeTimesRef = useRef<Float64Array | null>(null)
  const simulationStartedAtRef = useRef(0)
  const simulationElapsedAtPauseRef = useRef(0)
  const simulationElapsedAtSpeedChangeRef = useRef(0)
  const simulationSpeedRef = useRef(1)
  const simulationWallStartedAtRef = useRef(0)
  const simulationWallElapsedAtPauseRef = useRef(0)
  const simulationLastUiPublishRef = useRef(0)
  const simulationSourceLineRef = useRef<number | null>(null)
  const simulationStopTimerRef = useRef<number | null>(null)
  const simulationToolPosRef = useRef<{ x: number; y: number; z: number } | null>(null)
  const prevIsRunningRef = useRef(false)
  const prevModelRef = useRef<GCodeModel | null>(null)
  const [simulationPhase, setSimulationPhase] = useState<SimulationPhase>('idle')
  const [simulationElapsedSeconds, setSimulationElapsedSeconds] = useState(0)
  const [simulationWallElapsedSeconds, setSimulationWallElapsedSeconds] = useState(0)
  const [simulationTotalSeconds, setSimulationTotalSeconds] = useState<number | null>(null)
  const [simulationSpeedPercent, setSimulationSpeedPercent] = useState(100)

  useEffect(() => {
    if (!fitToViewSignal) return
    // The tablet accordion animates its height; fit after that transition has
    // settled so the camera uses the final canvas dimensions.
    const timeout = window.setTimeout(() => {
      needsFitRef.current = true
      scheduleRender()
    }, 320)
    return () => window.clearTimeout(timeout)
  }, [fitToViewSignal])

  const [is3D, setIs3D] = useState(false)
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('orthographic')
  const [dragMode, setDragMode] = useState<DragMode>('orbit')
  const [hoveredViewTarget, setHoveredViewTarget] = useState<string | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const cameraRef = useRef<Camera>({
    position: { x: 100, y: 100, z: 100 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 1000,
    projection: 'orthographic',
    orthoSize: Math.tan(Math.PI / 8) * 100,
  })
  const [orbitState, setOrbitState] = useState<OrbitState>({
    theta: Math.PI / 4,
    phi: Math.PI / 4,
    radius: 100,
    orthoSize: Math.tan(Math.PI / 8) * 100,
    target: { x: 0, y: 0, z: 0 },
  })
  const orbitDragRef = useRef<{
    x: number
    y: number
  } | null>(null)
  const panDragRef = useRef<{
    sx: number
    sy: number
    target: Vector3
    right: Vector3
    screenUp: Vector3
    worldUnitsPerPixel: number
  } | null>(null)
  const snapAnimRef = useRef<{ frameId: number } | null>(null)

  function cancelSnapAnimation() {
    if (snapAnimRef.current) {
      cancelAnimationFrame(snapAnimRef.current.frameId)
      snapAnimRef.current = null
    }
  }

  function snapOrbitToView(targetTheta: number, targetPhi: number) {
    cancelSnapAnimation()
    const startTheta = orbitState.theta
    const startPhi = orbitState.phi
    const dTheta = ((targetTheta - startTheta) % TAU + TAU * 1.5) % TAU - Math.PI
    const endTheta = startTheta + dTheta
    const startTime = performance.now()
    const DURATION = 350

    function tick(now: number) {
      const t = Math.min((now - startTime) / DURATION, 1)
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      const nextOrbit: OrbitState = {
        ...orbitState,
        theta: startTheta + (endTheta - startTheta) * eased,
        phi: startPhi + (targetPhi - startPhi) * eased,
      }
      setOrbitState(nextOrbit)
      updateCameraFromOrbit(nextOrbit)
      scheduleRender()
      if (t < 1) {
        snapAnimRef.current = { frameId: requestAnimationFrame(tick) }
      } else {
        snapAnimRef.current = null
      }
    }

    snapAnimRef.current = { frameId: requestAnimationFrame(tick) }
  }

  function initWebGLRenderer() {
    const canvas = webglCanvasRef.current
    if (!canvas) return

    rendererRef.current = null
    const renderer = createRenderer(canvas)
    if (renderer) {
      rendererRef.current = renderer
      updateCameraFromOrbit()
    } else {
      console.error('Failed to initialize WebGL renderer - WebGL not supported')
    }
  }

  function updateCameraFromOrbit(orbit = orbitState) {
    const camera = cameraRef.current
    let cameraOrbit = orbit

    if (projectionMode === 'orthographic') {
      const clipBounds = getClipBounds((modelRef.current ?? model)?.bounds ?? null)
      const diagonal = Math.hypot(
        clipBounds.maxX - clipBounds.minX,
        clipBounds.maxY - clipBounds.minY,
        clipBounds.maxZ - clipBounds.minZ,
      )
      let safeRadius = orbit.radius
      for (const corner of getBoundsCorners(clipBounds)) {
        const relative = subtractVectors(corner, orbit.target)
        safeRadius = Math.max(safeRadius, Math.hypot(relative.x, relative.y, relative.z))
      }
      cameraOrbit = {
        ...orbit,
        radius: safeRadius + Math.max(CAMERA_CLIP_PADDING_MIN, diagonal * CAMERA_CLIP_PADDING_RATIO),
      }
    }

    camera.target.x = orbit.target.x
    camera.target.y = orbit.target.y
    camera.target.z = orbit.target.z
    const position = getOrbitCameraPosition(cameraOrbit)
    camera.position.x = position.x
    camera.position.y = position.y
    camera.position.z = position.z
    camera.projection = projectionMode
    camera.orthoSize = Math.max(orbit.orthoSize, 1e-3)
    updateCameraClipping(cameraOrbit)
  }

  function updateCameraClipping(orbit = orbitState, mdl = modelRef.current ?? model) {
    const camera = cameraRef.current

    const clipBounds = getClipBounds(mdl ? mdl.bounds : null)
    const position = getOrbitCameraPosition(orbit)
    const { forward } = getOrbitCameraBasis(orbit, camera.up)
    const corners = getBoundsCorners(clipBounds)
    const diagonal = Math.hypot(
      clipBounds.maxX - clipBounds.minX,
      clipBounds.maxY - clipBounds.minY,
      clipBounds.maxZ - clipBounds.minZ,
    )
    const padding = Math.max(
      CAMERA_CLIP_PADDING_MIN,
      diagonal * CAMERA_CLIP_PADDING_RATIO,
      orbit.radius * CAMERA_CLIP_PADDING_RATIO,
    )

    let minDepth = Number.POSITIVE_INFINITY
    let maxDepth = Number.NEGATIVE_INFINITY

    for (const corner of corners) {
      const depth = dotProduct(subtractVectors(corner, position), forward)
      minDepth = Math.min(minDepth, depth)
      maxDepth = Math.max(maxDepth, depth)
    }

    if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
      camera.near = 0.1
      camera.far = 1000
      return
    }

    camera.near = Math.max(CAMERA_CLIP_NEAR_MIN, minDepth - padding)
    camera.far = Math.max(camera.near + padding * 2, maxDepth + padding)
  }

  function getScreenAnchor(clientX: number, clientY: number): ScreenAnchor | null {
    const container = containerRef.current
    if (!container) return null

    const rect = container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const localX = clientX - rect.left
    const localY = clientY - rect.top
    return {
      ndcX: (localX / rect.width) * 2 - 1,
      ndcY: 1 - (localY / rect.height) * 2,
      aspect: rect.width / rect.height,
    }
  }

  function zoomOrbitTowardAnchor(prev: OrbitState, zoomFactor: number, anchor: ScreenAnchor | null): OrbitState {
    const nextRadius = projectionMode === 'orthographic'
      ? prev.radius
      : Math.max(1, prev.radius * zoomFactor)
    const nextOrthoSize = projectionMode === 'orthographic'
      ? Math.max(1e-3, prev.orthoSize * zoomFactor)
      : prev.orthoSize

    if (!anchor || (Math.abs(nextRadius - prev.radius) < 1e-9 && Math.abs(nextOrthoSize - prev.orthoSize) < 1e-9)) {
      return { ...prev, radius: nextRadius, orthoSize: nextOrthoSize }
    }

    const camera = cameraRef.current
    const target = prev.target
    const position = {
      x: target.x + prev.radius * Math.sin(prev.phi) * Math.cos(prev.theta),
      y: target.y + prev.radius * Math.sin(prev.phi) * Math.sin(prev.theta),
      z: target.z + prev.radius * Math.cos(prev.phi),
    }
    const forward = normalizeVector(target.x - position.x, target.y - position.y, target.z - position.z)
    const right = normalizeVector(...Object.values(crossProduct(forward, camera.up)) as [number, number, number])
    const screenUp = normalizeVector(...Object.values(crossProduct(right, forward)) as [number, number, number])

    const raySlopeY = Math.tan(camera.fov / 2)
    const raySlopeX = raySlopeY * anchor.aspect
    const rayOffset = addVectors(
      scaleVector(right, anchor.ndcX * raySlopeX),
      scaleVector(screenUp, anchor.ndcY * raySlopeY),
    )
    const rayDirection = normalizeVector(
      forward.x + rayOffset.x,
      forward.y + rayOffset.y,
      forward.z + rayOffset.z,
    )

    const planeZ = target.z
    if (projectionMode === 'perspective' && Math.abs(rayDirection.z) > 1e-6) {
      const oldDistance = (planeZ - position.z) / rayDirection.z
      const nextPosition = {
        x: target.x + nextRadius * Math.sin(prev.phi) * Math.cos(prev.theta),
        y: target.y + nextRadius * Math.sin(prev.phi) * Math.sin(prev.theta),
        z: target.z + nextRadius * Math.cos(prev.phi),
      }
      const newDistance = (planeZ - nextPosition.z) / rayDirection.z

      if (oldDistance > 0 && newDistance > 0) {
        const oldAnchor = addVectors(position, scaleVector(rayDirection, oldDistance))
        const newAnchor = addVectors(nextPosition, scaleVector(rayDirection, newDistance))
        const delta = subtractVectors(oldAnchor, newAnchor)

        return {
          ...prev,
          radius: nextRadius,
          orthoSize: nextOrthoSize,
          target: {
            x: target.x + delta.x,
            y: target.y + delta.y,
            z: target.z,
          },
        }
      }
    }

    const oldHalfHeight = projectionMode === 'orthographic'
      ? prev.orthoSize
      : Math.tan(camera.fov / 2) * prev.radius
    const oldHalfWidth = oldHalfHeight * anchor.aspect
    const newHalfHeight = projectionMode === 'orthographic'
      ? nextOrthoSize
      : Math.tan(camera.fov / 2) * nextRadius
    const newHalfWidth = newHalfHeight * anchor.aspect

    const oldOffset = addVectors(
      scaleVector(right, anchor.ndcX * oldHalfWidth),
      scaleVector(screenUp, anchor.ndcY * oldHalfHeight),
    )
    const newOffset = addVectors(
      scaleVector(right, anchor.ndcX * newHalfWidth),
      scaleVector(screenUp, anchor.ndcY * newHalfHeight),
    )

    return {
      ...prev,
      radius: nextRadius,
      orthoSize: nextOrthoSize,
      target: {
        x: target.x + oldOffset.x - newOffset.x,
        y: target.y + oldOffset.y - newOffset.y,
        z: target.z + oldOffset.z - newOffset.z,
      },
    }
  }

  function start3DDrag(clientX: number, clientY: number, mode: DragMode) {
    cancelSnapAnimation()

    if (mode === 'pan') {
      const containerHeight = Math.max(containerRef.current?.clientHeight ?? 0, 1)
      const camera = cameraRef.current
      const { right, screenUp } = getOrbitCameraBasis(orbitState, camera.up)
      const halfHeight = projectionMode === 'orthographic'
        ? orbitState.orthoSize
        : Math.tan(camera.fov / 2) * orbitState.radius

      panDragRef.current = {
        sx: clientX,
        sy: clientY,
        target: { ...orbitState.target },
        right,
        screenUp,
        worldUnitsPerPixel: (halfHeight * 2) / containerHeight,
      }
      orbitDragRef.current = null
      return
    }

    orbitDragRef.current = {
      x: clientX,
      y: clientY,
    }
    panDragRef.current = null
  }

  function createVertexData(
    segments: SegmentTable | null,
    progress: ToolpathProgress | null,
    toolWpos: { x: number; y: number; z: number } | null,
  ) {
    const vertices: number[] = []
    const colors: number[] = []
    const triangleVertices: number[] = []
    const triangleColors: number[] = []

    const RAPID_C     = [0.4,  0.5,  0.7,  1.0] as const
    const TRAVERSE_C  = [0.35, 0.6,  0.35, 0.7] as const
    const DONE_C      = [0.13, 0.77, 0.37, 1.0] as const
    const TOOL_C      = [0.94, 0.27, 0.27, 1.0] as const
    const TOOL_GLOW_C = [1.0,  0.27, 0.27, 0.55] as const
    const TOOL_CAP_C  = [1.0,  0.35, 0.35, 0.38] as const
    const TOOL_TIP_C  = [1.0,  0.96, 0.96, 1.0] as const

    const segmentCount = segments?.length ?? 0
    for (let segIdx = 0; segIdx < segmentCount; segIdx++) {
      const seg = segments!.get(segIdx)
      if (seg.moveType !== 'feed' && !showRapidsRef.current) continue
      if (seg.tool != null && hiddenToolsRef.current.has(seg.tool)) continue

      if (seg.moveType !== 'feed') {
        const nonFeedColor = seg.moveType === 'rapid' ? RAPID_C : TRAVERSE_C
        if (seg.i !== undefined) {
          const arc = getArcGeometry(seg)
          const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
          for (let i = 0; i < numSubs; i++) {
            const t1 = i / numSubs
            const t2 = (i + 1) / numSubs
            const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
            const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
            vertices.push(
              arc.cx + Math.cos(angle1) * arc.r, arc.cy + Math.sin(angle1) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t1,
              arc.cx + Math.cos(angle2) * arc.r, arc.cy + Math.sin(angle2) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t2,
            )
            colors.push(...nonFeedColor, ...nonFeedColor)
          }
        } else {
          vertices.push(seg.x0, seg.y0, seg.z0, seg.x1, seg.y1, seg.z1)
          colors.push(...nonFeedColor, ...nonFeedColor)
        }
        continue
      }

      const isDone    = progress !== null && segIdx < progress.segmentIndex
      const isCurrent = progress !== null && segIdx === progress.segmentIndex
      const frac      = isCurrent ? progress!.fraction : 1
      const cutColor = toolPathColorRgba(seg.tool)

      if (seg.i !== undefined) {
        const arc = getArcGeometry(seg)
        const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
        for (let i = 0; i < numSubs; i++) {
          const t1 = i / numSubs
          const t2 = (i + 1) / numSubs
          const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
          const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
          vertices.push(
            arc.cx + Math.cos(angle1) * arc.r, arc.cy + Math.sin(angle1) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t1,
            arc.cx + Math.cos(angle2) * arc.r, arc.cy + Math.sin(angle2) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t2,
          )
          const subDone = isDone || (isCurrent && t2 <= frac)
          colors.push(...(subDone ? DONE_C : cutColor), ...(subDone ? DONE_C : cutColor))
        }
      } else {
        if (isDone) {
          vertices.push(seg.x0, seg.y0, seg.z0, seg.x1, seg.y1, seg.z1)
          colors.push(...DONE_C, ...DONE_C)
        } else if (isCurrent && frac > 0 && frac < 1) {
          const mx = seg.x0 + (seg.x1 - seg.x0) * frac
          const my = seg.y0 + (seg.y1 - seg.y0) * frac
          const mz = seg.z0 + (seg.z1 - seg.z0) * frac
          vertices.push(seg.x0, seg.y0, seg.z0, mx, my, mz)
          colors.push(...DONE_C, ...DONE_C)
          vertices.push(mx, my, mz, seg.x1, seg.y1, seg.z1)
          colors.push(...cutColor, ...cutColor)
        } else {
          const c = isCurrent && frac >= 1 ? DONE_C : cutColor
          vertices.push(seg.x0, seg.y0, seg.z0, seg.x1, seg.y1, seg.z1)
          colors.push(...c, ...c)
        }
      }
    }

    const toolVertexStart = vertices.length / 3

    if (toolWpos) {
      const { x, y, z } = toolWpos
      const baseZ = z + TOOLHEAD_CONE_HEIGHT
      appendConeGeometry(
        vertices,
        colors,
        triangleVertices,
        triangleColors,
        { x, y, z },
        TOOLHEAD_CONE_HEIGHT,
        TOOLHEAD_CONE_RADIUS,
        TOOL_C,
        TOOL_GLOW_C,
        'down',
        24,
        0,
        TOOL_CAP_C,
      )

      vertices.push(x, y, z, x, y, baseZ)
      colors.push(...TOOL_C, ...TOOL_C)
      vertices.push(x - TOOLHEAD_TIP_CROSS, y, z, x + TOOLHEAD_TIP_CROSS, y, z)
      vertices.push(x, y - TOOLHEAD_TIP_CROSS, z, x, y + TOOLHEAD_TIP_CROSS, z)
      vertices.push(x, y, z, x, y, z + TOOLHEAD_TIP_STEM)
      colors.push(...TOOL_TIP_C, ...TOOL_TIP_C, ...TOOL_TIP_C, ...TOOL_TIP_C, ...TOOL_TIP_C, ...TOOL_TIP_C)
    }

    return {
      vertices: new Float32Array(vertices),
      colors: new Float32Array(colors),
      triangleVertices: new Float32Array(triangleVertices),
      triangleColors: new Float32Array(triangleColors),
      toolVertexStart,
    }
  }

  function ensureStaticPathGeometry(mdl: GCodeModel) {
    let geometry = staticPathGeometryRef.current
    if (!geometry || geometry.model !== mdl || geometry.showRapids !== showRapidsRef.current) return null

    // Filter hidden tools once per change instead of rebuilding every frame.
    const hiddenTools = hiddenToolsRef.current
    if (hiddenTools.size > 0) {
      const filtered = filteredPathGeometryRef.current
      if (filtered && filtered.model === mdl && filtered.showRapids === geometry.showRapids && filtered.hiddenTools === hiddenTools) {
        geometry = filtered
      } else {
        const lines = renderLinesRef.current
        if (!lines) return null
        geometry = {
          model: mdl,
          showRapids: geometry.showRapids,
          hiddenTools,
          ...buildStatic3DGeometry(lines, geometry.showRapids, hiddenTools),
        }
        filteredPathGeometryRef.current = geometry
      }
    }

    const renderer = rendererRef.current
    const uploaded = uploadedPathGeometryRef.current
    if (renderer && (uploaded?.geometry !== geometry || uploaded.renderer !== renderer)) {
      setStaticLineData(renderer, geometry.vertices, geometry.colors)
      uploadedPathGeometryRef.current = { geometry, renderer }
    }

    return geometry
  }

  function clearStaticPathGeometryUpload() {
    if (rendererRef.current && uploadedPathGeometryRef.current) {
      setStaticLineData(rendererRef.current, EMPTY_FLOAT32, EMPTY_UINT8)
    }
    uploadedPathGeometryRef.current = null
  }

  function ensureCumulativeXYLengths(mdl: GCodeModel) {
    const cached = pathXYLengthsRef.current
    if (cached && cached.model === mdl) return cached.cumulative

    const built = { model: mdl, cumulative: buildCumulativeXYLengths(mdl.segments) }
    pathXYLengthsRef.current = built
    return built.cumulative
  }

  function ensureEntryExitMarkerGeometry(mdl: GCodeModel) {
    const cached = markerGeometryRef.current
    if (cached && cached.model === mdl) return cached

    const geometry = buildEntryExitMarkerGeometry(mdl.segments)
    const built = { model: mdl, ...geometry }
    markerGeometryRef.current = built
    return built
  }

  function ensureStatic2DPaths(mdl: GCodeModel) {
    const cached = static2DPathsRef.current
    if (cached && cached.model === mdl) return cached

    // The store builds these paths in time slices. Building them here blocks
    // the page, so skip it for large jobs (for example while the next file loads).
    if (mdl.segments.length > LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT) return null
    const paths = { model: mdl, ...buildStatic2DPaths(buildRenderLines(mdl.segments)) }
    static2DPathsRef.current = paths
    return paths
  }

  /**
   * Draws the toolpath from a cached layer. Status reports redraw the tool
   * marker several times a second, and re-stroking millions of lines each
   * time would starve the page. While a large layer is panned or zoomed, the
   * cached image is stretched into place and stroked again once the view settles.
   */
  function drawStatic2DLayer(ctx: CanvasRenderingContext2D, paths: Static2DPaths, t: Transform, w: number, h: number, lineCount: number) {
    const dpr = window.devicePixelRatio || 1
    const showRapids = showRapidsRef.current
    const hiddenTools = hiddenToolsRef.current
    const layer = static2DLayerRef.current
    const sameContent = !!layer && layer.paths === paths && layer.w === w && layer.h === h && layer.dpr === dpr
      && layer.showRapids === showRapids && layer.hiddenTools === hiddenTools
    const sameView = sameContent && layer.ox === t.ox && layer.oy === t.oy && layer.scale === t.scale

    if (layer && sameContent && !sameView && !layer.settled && lineCount > LARGE_2D_LAYER_LINE_LIMIT) {
      const k = t.scale / layer.scale
      ctx.drawImage(layer.canvas, t.ox - layer.ox * k, t.oy - layer.oy * k, w * k, h * k)
      window.clearTimeout(static2DSettleTimerRef.current)
      static2DSettleTimerRef.current = window.setTimeout(() => {
        layer.settled = true
        scheduleRender()
      }, STATIC_2D_SETTLE_MS)
      return
    }

    if (!layer || !sameView) {
      const canvas = layer?.canvas ?? document.createElement('canvas')
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const layerCtx = canvas.getContext('2d')
      if (!layerCtx) return
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      strokeStatic2DPaths(layerCtx, paths, t, showRapids, hiddenTools)
      static2DLayerRef.current = { paths, canvas, ox: t.ox, oy: t.oy, scale: t.scale, w, h, dpr, showRapids, hiddenTools, settled: false }
      ctx.drawImage(canvas, 0, 0, w, h)
      return
    }

    ctx.drawImage(layer.canvas, 0, 0, w, h)
  }

  function ensureProgress2DPath(mdl: GCodeModel, progress: ToolpathProgress) {
    const lastCompletedSegment = progress.segmentIndex - 1
    let cached = progress2DPathRef.current

    if (
      !cached
      || cached.model !== mdl
      || lastCompletedSegment < cached.lastCompletedSegment
    ) {
      cached = { model: mdl, path: new Path2D(), lastCompletedSegment: -1 }
      progress2DPathRef.current = cached
    }

    for (let i = cached.lastCompletedSegment + 1; i <= lastCompletedSegment; i++) {
      if (mdl.segments.moveCode(i) !== MOVE_FEED) continue
      const tool = mdl.segments.tool(i)
      if (tool == null || !hiddenToolsRef.current.has(tool)) addSegmentToPath(cached.path, mdl.segments.get(i))
    }
    cached.lastCompletedSegment = lastCompletedSegment
    return cached.path
  }

  const status = useMachineStore(s => s.status)
  const connected = useMachineStore(s => s.connected)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const units = useMachineStore(s => s.units)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderJobId = useGCodeSenderStore(s => s.jobId)
  const senderShowRuntimeEstimate = useGCodeSenderStore(s => s.showRuntimeEstimate)
  const senderAcceptedLine = useGCodeSenderStore(s => s.acceptedLine)
  const senderNotice = useGCodeSenderStore(s => s.notice)
  const senderError = useGCodeSenderStore(s => s.error)
  const senderFailureLine = useGCodeSenderStore(s => s.failureLine)
  const senderFailureLineSource = useGCodeSenderStore(s => s.failureLineSource)
  const startSender = useGCodeSenderStore(s => s.start)
  const pauseSender = useGCodeSenderStore(s => s.pause)
  const resumeSender = useGCodeSenderStore(s => s.resume)
  const abortSender = useGCodeSenderStore(s => s.abort)
  const dismissSender = useGCodeSenderStore(s => s.dismiss)
  const trackedJobSource = useGCodeStore(s => s.trackedJob?.source)
  const startTrackedJob = useGCodeStore(s => s.startTrackedJob)
  const cancelTrackedJob = useGCodeStore(s => s.cancelTrackedJob)
  const finishedJobElapsedMs = useGCodeStore(s => s.finishedJobElapsedMs)
  const dismissFinishedJobNotice = useGCodeStore(s => s.dismissFinishedJobNotice)
  const senderActive = senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
  const runtime = useJobRuntimeEstimate(
    status,
    model,
    controllerSettings,
    loadedPath,
    fileName,
    { active: senderActive, key: `${senderJobId}|${fileName ?? ''}` },
  )
  const progressPercent = runtime.progressPercent
  const showEstimatedTiming = runtime.source === 'estimated' && (!senderActive || senderShowRuntimeEstimate)
  const simulationActive = simulationPhase !== 'idle'
  const simulationPaused = simulationPhase === 'paused'
  // FluidNC stays Idle while a configured spindle spins up. Keep the requested
  // controller job visibly active during that interval so Start cannot be
  // pressed twice and the abort control remains immediately available.
  const controllerJobStarting = trackedJobSource === 'controller' && status.state === 'Idle'
  const machineJobActive = status.state === 'Run' || status.state === 'Hold' || senderActive || controllerJobStarting
  const isRunning = machineJobActive || simulationActive
  const isJobRunning = senderPhase === 'streaming' || senderPhase === 'draining'
    || (status.state === 'Run' && senderPhase !== 'paused') || controllerJobStarting
  const isJobHeld = senderPhase === 'paused' || status.state === 'Hold'
  const isLargeProgressOverlayDisabled = !!model && isRunning && model.segments.length > LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT
  const cancelAndStartJob = useGCodeStore(s => s.cancelAndStartJob)
  const cancelLoad = useGCodeStore(s => s.clear)
  const handleStartWithoutPreview = useCallback(() => {
    const path = pendingPath
    if (!path) return
    if (cancelAndStartJob(path)) startTrackedJob('controller')
  }, [pendingPath, cancelAndStartJob, startTrackedJob])

  const isViewerStartBlocked = loading || isProcessing2D || pendingPath !== null || !!sdUploadPath || controllerResetPending
  const is3DToggleDisabled = pendingPath !== null || isProcessing2D || (!!model && !is3DReady)
  const [autoFollow, setAutoFollow] = useState(true)
  const [coolantState, setCoolantState] = useState<'off' | 'mist' | 'flood'>('off')
  const [showRestartFromLine, setShowRestartFromLine] = useState(false)
  const [showLocalSenderWarning, setShowLocalSenderWarning] = useState(false)
  const [showFramingDialog, setShowFramingDialog] = useState(false)
  const [framingMode, setFramingMode] = useState<FramingMode>(() => getStoredFramingMode())
  const [framingFeedInput, setFramingFeedInput] = useState(() => formatInputValue(mmToDisplay(getStoredPositiveNumber(FRAMING_FEED_KEY, 1000), units), units === 'in' ? 2 : 0))
  const [framingClearanceInput, setFramingClearanceInput] = useState(() => formatInputValue(mmToDisplay(getStoredFiniteNumber(FRAMING_CLEARANCE_KEY, 5), units), units === 'in' ? 3 : 1))
  const [framingTravelZInput, setFramingTravelZInput] = useState(() => formatInputValue(mmToDisplay(getStoredFiniteNumber(FRAMING_TRAVEL_Z_KEY, 5), units), units === 'in' ? 3 : 1))
  const [framingError, setFramingError] = useState<string | null>(null)
  const [restartInitialLine, setRestartInitialLine] = useState<number | null>(null)
  const isLocalFile = !!sourceText && !loadedPath
  const simulationProgressPercent = simulationTotalSeconds && simulationTotalSeconds > 0
    ? clamp01(simulationElapsedSeconds / simulationTotalSeconds) * 100
    : null
  const displayedProgressPercent = simulationActive
    ? simulationProgressPercent
    : senderActive ? senderExecutionProgressPercent : progressPercent
  const showDisplayedTiming = simulationActive || showEstimatedTiming
  const simulationSpeedScale = simulationSpeedPercent / 100
  const simulationRemainingWallSeconds = simulationActive && simulationTotalSeconds != null
    ? Math.max(0, simulationTotalSeconds - simulationElapsedSeconds) / simulationSpeedScale
    : null
  const displayedElapsedSeconds = simulationActive ? simulationWallElapsedSeconds : runtime.elapsedSeconds
  const displayedRemainingSeconds = simulationActive && simulationTotalSeconds != null
    ? simulationRemainingWallSeconds
    : runtime.remainingSeconds
  const displayedTotalSeconds = simulationActive
    ? simulationRemainingWallSeconds != null ? simulationWallElapsedSeconds + simulationRemainingWallSeconds : null
    : runtime.totalSeconds
  const safeMachineZ = controllerSettings.machineMaxZ == null
    ? null
    : controllerSettings.machineMaxZ - Math.min(1, Math.max(0.1, (controllerSettings.maxTravelZ ?? 100) * 0.005))

  // Keep refs in sync so render() (called from non-React contexts) reads current values
  showRapidsRef.current = showRapids
  showToolRef.current = showTool
  hiddenToolsRef.current = hiddenTools

  useEffect(() => {
    const previousModel = modelRef.current
    const modelChanged = model !== previousModel
    modelRef.current = model
    static2DPathsRef.current = (storePaths2D && model)
      ? { model, rapidPath: storePaths2D.rapidPath, traversePath: storePaths2D.traversePath, cutPath: storePaths2D.cutPath, toolPaths: storePaths2D.toolPaths }
      : null
    staticPathGeometryRef.current = (storeGeometry3D && model)
      ? {
          model,
          showRapids: storeGeometry3D.showRapids,
          hiddenTools: null,
          vertices: storeGeometry3D.vertices,
          colors: storeGeometry3D.colors,
        }
      : null
    filteredPathGeometryRef.current = null
    static2DLayerRef.current = null
    renderLinesRef.current = model ? storeRenderLines : null
    markerGeometryRef.current = null
    pathXYLengthsRef.current = null
    if (modelChanged) {
      if (simulationPhaseRef.current !== 'idle') stopSimulation()
      progressRef.current = null
      setHiddenTools(new Set())
      setShowToolPathMenu(false)
    }
    if (model && modelChanged) {
      needsFitRef.current = true
      if (is3D && !storeGeometry3D) {
        setIs3D(false)
      }
    }
    scheduleRender()
  }, [model, storePaths2D, storeGeometry3D, storeRenderLines, is3D])

  useEffect(() => () => window.clearTimeout(static2DSettleTimerRef.current), [])

  function canvasLogicalSize() {
    const container = containerRef.current
    if (!container) return { w: 300, h: 300 }
    const rect = container.getBoundingClientRect()
    return { w: rect.width, h: rect.height }
  }

  function fitToView(m?: GCodeModel | null) {
    const mdl = m === undefined ? model : m
    const machineStore = useMachineStore.getState()
    const { maxTravelX: bedW, maxTravelY: bedH } = machineStore.controllerSettings
    if (!mdl && (bedW == null || bedH == null)) return

    if (is3D) {
      cancelSnapAnimation()
      const { w, h } = canvasLogicalSize()
      // Keep the orbit pivot on the part. Clipping still accounts for the bed,
      // but including it here makes small or offset parts orbit around empty space.
      const viewBounds = mdl?.bounds ?? getClipBounds(null)
      const centerX = (viewBounds.minX + viewBounds.maxX) / 2
      const centerY = (viewBounds.minY + viewBounds.maxY) / 2
      const centerZ = (viewBounds.minZ + viewBounds.maxZ) / 2
      const camera = cameraRef.current
      const aspect = Math.max(w / Math.max(h, 1), 1e-6)
      const tanHalfFov = Math.max(Math.tan(camera.fov / 2), 1e-6)
      const target = { x: centerX, y: centerY, z: centerZ }
      const fitOrbit = { ...orbitState, target }
      const { forward, right, screenUp } = getOrbitCameraBasis(fitOrbit, camera.up)
      const corners = getBoundsCorners(viewBounds)
      let nextRadius = 1
      let nextOrthoSize = orbitState.orthoSize

      if (projectionMode === 'orthographic') {
        let maxRight = 0
        let maxUp = 0
        let maxTargetDistance = 0
        const diagonal = Math.hypot(
          viewBounds.maxX - viewBounds.minX,
          viewBounds.maxY - viewBounds.minY,
          viewBounds.maxZ - viewBounds.minZ,
        )
        const depthPadding = Math.max(CAMERA_CLIP_PADDING_MIN, diagonal * CAMERA_CLIP_PADDING_RATIO)

        for (const corner of corners) {
          const relative = subtractVectors(corner, target)
          maxRight = Math.max(maxRight, Math.abs(dotProduct(relative, right)))
          maxUp = Math.max(maxUp, Math.abs(dotProduct(relative, screenUp)))
          maxTargetDistance = Math.max(
            maxTargetDistance,
            Math.hypot(relative.x, relative.y, relative.z),
          )
        }

        const requiredHalfHeight = Math.max(maxUp, maxRight / aspect)
        nextOrthoSize = Math.max(1e-3, requiredHalfHeight * VIEW_FIT_PADDING)
        nextRadius = Math.max(1, maxTargetDistance + depthPadding)
      } else {
        for (const corner of corners) {
          const relative = subtractVectors(corner, target)
          const horizontalRadius = Math.abs(dotProduct(relative, right)) / (tanHalfFov * aspect)
          const verticalRadius = Math.abs(dotProduct(relative, screenUp)) / tanHalfFov
          const depthOffset = dotProduct(relative, forward)
          nextRadius = Math.max(nextRadius, horizontalRadius - depthOffset, verticalRadius - depthOffset)
        }

        nextRadius *= VIEW_FIT_PADDING
      }

      const nextOrbit = {
        ...orbitState,
        radius: nextRadius,
        orthoSize: nextOrthoSize,
        target,
      }

      setOrbitState(nextOrbit)
      updateCameraFromOrbit(nextOrbit)
    } else {
      const { w, h } = canvasLogicalSize()
      let bMinX: number, bMinY: number, bMaxX: number, bMaxY: number
      if (mdl) {
        bMinX = mdl.bounds.minX
        bMinY = mdl.bounds.minY
        bMaxX = mdl.bounds.maxX
        bMaxY = mdl.bounds.maxY
      } else {
        const bed = getBedEnvelope(machineStore.controllerSettings, machineStore.status)
        if (!bed) return
        bMinX = bed.originX
        bMinY = bed.originY
        bMaxX = bed.originX + bed.width
        bMaxY = bed.originY + bed.height
      }
      const modelW = bMaxX - bMinX || 1
      const modelH = bMaxY - bMinY || 1
      const pad = 40
      const scale = Math.min((w - pad * 2) / modelW, (h - pad * 2) / modelH)
      const cx = (bMinX + bMaxX) / 2
      const cy = (bMinY + bMaxY) / 2
      transformRef.current = {
        ox: w / 2 - cx * scale,
        oy: h / 2 + cy * scale,
        scale,
      }
    }

    scheduleRender()
  }

  function scheduleRender() {
    if (animRef.current) return
    animRef.current = requestAnimationFrame(() => {
      animRef.current = 0
      renderRef.current()
    })
  }

  function publishSimulationProgress(elapsedSeconds: number, timing: JobTimingEstimate, phase: SimulationPhase) {
    const mdl = modelRef.current
    const cumulative = simulationCumulativeTimesRef.current ?? buildCumulativeSegmentTimes(timing)
    simulationCumulativeTimesRef.current = cumulative
    const progress = getSimulationProgressAt(timing, cumulative, elapsedSeconds)
    const clampedElapsed = Math.max(0, Math.min(elapsedSeconds, timing.totalSeconds))
    progressRef.current = progress
    simulationElapsedAtPauseRef.current = clampedElapsed
    const progressSegment = mdl && progress ? segmentAt(mdl.segments, progress.segmentIndex) : undefined
    simulationToolPosRef.current = progressSegment && progress
      ? getSegmentPoint(progressSegment, progress.fraction)
      : null

    const sourceLine = progressSegment?.sourceLine ?? null
    const wallElapsed = phase === 'paused'
      ? simulationWallElapsedAtPauseRef.current
      : getCurrentSimulationWallElapsed()
    const now = performance.now()
    const shouldPublishUi = phase !== simulationPhaseRef.current
      || clampedElapsed === 0
      || clampedElapsed >= timing.totalSeconds
      || now - simulationLastUiPublishRef.current >= 250
    if (shouldPublishUi) {
      simulationLastUiPublishRef.current = now
      setSimulationElapsedSeconds(clampedElapsed)
      setSimulationWallElapsedSeconds(wallElapsed)
      setSimulationPhase(phase)
      if (sourceLine !== simulationSourceLineRef.current) {
        simulationSourceLineRef.current = sourceLine
        setActiveSourceLine(sourceLine)
      }
    }
    simulationPhaseRef.current = phase
    scheduleRender()
  }

  function cancelSimulationFrame() {
    if (simulationFrameRef.current) {
      cancelAnimationFrame(simulationFrameRef.current)
      simulationFrameRef.current = 0
    }
  }

  function getCurrentSimulationWallElapsed() {
    if (simulationPhaseRef.current !== 'playing') {
      return Math.max(0, simulationWallElapsedAtPauseRef.current)
    }
    return simulationWallElapsedAtPauseRef.current
      + Math.max(0, performance.now() - simulationWallStartedAtRef.current) / 1000
  }

  function getCurrentSimulationElapsed() {
    const timing = simulationTimingRef.current
    if (!timing) return 0
    if (simulationPhaseRef.current !== 'playing') {
      return Math.max(0, Math.min(simulationElapsedAtPauseRef.current, timing.totalSeconds))
    }
    const elapsed = simulationElapsedAtSpeedChangeRef.current
      + ((performance.now() - simulationStartedAtRef.current) / 1000) * simulationSpeedRef.current
    return Math.max(0, Math.min(elapsed, timing.totalSeconds))
  }

  function setSimulationSpeedPercentClamped(nextPercent: number) {
    const next = Math.max(SIMULATION_SPEED_MIN, Math.min(SIMULATION_SPEED_MAX, nextPercent))
    const currentElapsed = getCurrentSimulationElapsed()
    const currentWallElapsed = getCurrentSimulationWallElapsed()
    simulationSpeedRef.current = next / 100
    simulationElapsedAtSpeedChangeRef.current = currentElapsed
    simulationElapsedAtPauseRef.current = currentElapsed
    simulationStartedAtRef.current = performance.now()
    simulationWallElapsedAtPauseRef.current = currentWallElapsed
    simulationWallStartedAtRef.current = performance.now()
    setSimulationSpeedPercent(next)
    const timing = simulationTimingRef.current
    if (timing) publishSimulationProgress(currentElapsed, timing, simulationPhaseRef.current)
  }

  function stopSimulation(phase: SimulationPhase = 'idle') {
    cancelSimulationFrame()
    if (simulationStopTimerRef.current) {
      window.clearTimeout(simulationStopTimerRef.current)
      simulationStopTimerRef.current = null
    }
    simulationPhaseRef.current = phase
    simulationTimingRef.current = null
    simulationCumulativeTimesRef.current = null
    simulationStartedAtRef.current = 0
    simulationElapsedAtPauseRef.current = 0
    simulationElapsedAtSpeedChangeRef.current = 0
    simulationWallStartedAtRef.current = 0
    simulationWallElapsedAtPauseRef.current = 0
    simulationLastUiPublishRef.current = 0
    simulationSourceLineRef.current = null
    simulationToolPosRef.current = null
    if (phase !== 'completed') {
      progressRef.current = null
      setActiveSourceLine(null)
    }
    setSimulationPhase(phase)
    setSimulationElapsedSeconds(0)
    setSimulationWallElapsedSeconds(0)
    setSimulationTotalSeconds(null)
    scheduleRender()
  }

  function tickSimulation() {
    const timing = simulationTimingRef.current
    if (!timing || simulationPhaseRef.current !== 'playing') return

    const elapsedSeconds = getCurrentSimulationElapsed()
    if (elapsedSeconds >= timing.totalSeconds) {
      publishSimulationProgress(timing.totalSeconds, timing, 'completed')
      simulationFrameRef.current = 0
      simulationStopTimerRef.current = window.setTimeout(() => {
        simulationStopTimerRef.current = null
        if (simulationPhaseRef.current === 'completed') stopSimulation()
      }, 900)
      return
    }

    publishSimulationProgress(elapsedSeconds, timing, 'playing')
    simulationFrameRef.current = requestAnimationFrame(tickSimulation)
  }

  function getSimulationTiming(mdl: GCodeModel) {
    return buildJobTimingEstimate(mdl, controllerSettings, {
      feedPercent: status.feedOverride,
      rapidPercent: status.rapidOverride,
    })
  }

  function startSimulation() {
    if (!model || isViewerStartBlocked || machineJobActive) return
    const timing = getSimulationTiming(model)
    if (!timing) return
    cancelSimulationFrame()
    simulationTimingRef.current = timing
    simulationCumulativeTimesRef.current = buildCumulativeSegmentTimes(timing)
    simulationElapsedAtPauseRef.current = 0
    simulationElapsedAtSpeedChangeRef.current = 0
    simulationStartedAtRef.current = performance.now()
    simulationWallElapsedAtPauseRef.current = 0
    simulationWallStartedAtRef.current = performance.now()
    setSimulationTotalSeconds(timing.totalSeconds)
    publishSimulationProgress(0, timing, 'playing')
    simulationFrameRef.current = requestAnimationFrame(tickSimulation)
  }

  function pauseSimulation() {
    const timing = simulationTimingRef.current
    if (!timing || simulationPhaseRef.current !== 'playing') return
    simulationWallElapsedAtPauseRef.current = getCurrentSimulationWallElapsed()
    cancelSimulationFrame()
    publishSimulationProgress(getCurrentSimulationElapsed(), timing, 'paused')
  }

  function resumeSimulation() {
    const timing = simulationTimingRef.current
    if (!timing || simulationPhaseRef.current !== 'paused') return
    simulationElapsedAtSpeedChangeRef.current = simulationElapsedAtPauseRef.current
    simulationStartedAtRef.current = performance.now()
    simulationWallStartedAtRef.current = performance.now()
    simulationPhaseRef.current = 'playing'
    setSimulationPhase('playing')
    simulationFrameRef.current = requestAnimationFrame(tickSimulation)
  }

  function render() {
    const { w, h } = canvasLogicalSize()

    if (is3D) {
      const webglCanvas = webglCanvasRef.current
      if (!webglCanvas) return

      if (!rendererRef.current) {
        initWebGLRenderer()
        if (!rendererRef.current) return
      }

      const mdl = modelRef.current
      const store = useMachineStore.getState()
      const { maxTravelX: btx, maxTravelY: bty } = store.controllerSettings
      const bedReady3d = btx != null && bty != null

      if (needsFitRef.current && w > 1 && h > 1 && (mdl || bedReady3d)) {
        needsFitRef.current = false
        fitToView(mdl)
        return
      }

      updateCameraFromOrbit()
      cameraRef.current.aspect = w / h

      const simulationRendering3d = simulationPhaseRef.current !== 'idle'
      const running3d = store.status.state === 'Run' || store.status.state === 'Hold' || simulationRendering3d
      const progress3d = running3d ? progressRef.current : null
      const use3DProgressOverlay = mdl !== null && progress3d !== null && mdl.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT
      const wpos3d = showToolRef.current ? (simulationRendering3d ? simulationToolPosRef.current : store.status.wpos) : null
      const markerGeometry = mdl ? ensureEntryExitMarkerGeometry(mdl) : { vertices: EMPTY_FLOAT32, colors: EMPTY_FLOAT32, triangleVertices: EMPTY_FLOAT32, triangleColors: EMPTY_FLOAT32 }
      const bed3d = getBedEnvelope(store.controllerSettings, store.status)
      const bedGeometry = bed3d ? buildBedLineGeometry(bed3d.width, bed3d.height, bed3d.originX, bed3d.originY) : null

      if (!mdl) {
        if (!bedReady3d && !wpos3d) {
          rendererRef.current.gl.clear(rendererRef.current.gl.COLOR_BUFFER_BIT | rendererRef.current.gl.DEPTH_BUFFER_BIT)
          return
        }
        clearStaticPathGeometryUpload()
        const toolGeometry = wpos3d
          ? createVertexData(null, null, wpos3d)
          : { vertices: EMPTY_FLOAT32, colors: EMPTY_FLOAT32, triangleVertices: EMPTY_FLOAT32, triangleColors: EMPTY_FLOAT32, toolVertexStart: 0 }
        const mergedVertices = mergeFloat32Arrays(bedGeometry?.vertices ?? EMPTY_FLOAT32, toolGeometry.vertices)
        const mergedColors = mergeFloat32Arrays(bedGeometry?.colors ?? EMPTY_FLOAT32, toolGeometry.colors)
        const bedVertexCount = bedGeometry ? bedGeometry.vertices.length / 3 : 0
        const toolVertexStart = toolGeometry.vertices.length > 0 ? bedVertexCount : mergedVertices.length / 3
        renderLines(rendererRef.current, cameraRef.current, mergedVertices, mergedColors, toolVertexStart, 3, toolGeometry.triangleVertices, toolGeometry.triangleColors)
        return
      }

      if (!use3DProgressOverlay) {
        const staticGeometry = ensureStaticPathGeometry(mdl)
        if (!staticGeometry) return
        const toolGeometry = wpos3d
          ? createVertexData(null, null, wpos3d)
          : { vertices: EMPTY_FLOAT32, colors: EMPTY_FLOAT32, triangleVertices: EMPTY_FLOAT32, triangleColors: EMPTY_FLOAT32, toolVertexStart: 0 }
        const mergedVertices = mergeFloat32Arrays(bedGeometry?.vertices ?? EMPTY_FLOAT32, markerGeometry.vertices, toolGeometry.vertices)
        const mergedColors = mergeFloat32Arrays(bedGeometry?.colors ?? EMPTY_FLOAT32, markerGeometry.colors, toolGeometry.colors)
        const mergedTriangleVertices = mergeFloat32Arrays(markerGeometry.triangleVertices, toolGeometry.triangleVertices)
        const mergedTriangleColors = mergeFloat32Arrays(markerGeometry.triangleColors, toolGeometry.triangleColors)
        const bedVertexCount = bedGeometry ? bedGeometry.vertices.length / 3 : 0
        const markerVertexCount = markerGeometry.vertices.length / 3
        const toolVertexStart = toolGeometry.vertices.length > 0 ? bedVertexCount + markerVertexCount : mergedVertices.length / 3
        renderLines(rendererRef.current, cameraRef.current, mergedVertices, mergedColors, toolVertexStart, 3, mergedTriangleVertices, mergedTriangleColors)
      } else {
        clearStaticPathGeometryUpload()
        const { vertices, colors, triangleVertices, triangleColors, toolVertexStart } = createVertexData(mdl.segments, progress3d, wpos3d)
        const toolStartOffset = toolVertexStart * 3
        const mergedVertices = mergeFloat32Arrays(
          bedGeometry?.vertices ?? EMPTY_FLOAT32,
          vertices.subarray(0, toolStartOffset),
          markerGeometry.vertices,
          vertices.subarray(toolStartOffset),
        )
        const mergedColors = mergeFloat32Arrays(
          bedGeometry?.colors ?? EMPTY_FLOAT32,
          colors.subarray(0, toolStartOffset * 4 / 3),
          markerGeometry.colors,
          colors.subarray(toolStartOffset * 4 / 3),
        )
        const mergedTriangleVertices = mergeFloat32Arrays(markerGeometry.triangleVertices, triangleVertices)
        const mergedTriangleColors = mergeFloat32Arrays(markerGeometry.triangleColors, triangleColors)
        renderLines(
          rendererRef.current,
          cameraRef.current,
          mergedVertices,
          mergedColors,
          toolVertexStart + (bedGeometry ? bedGeometry.vertices.length / 3 : 0) + markerGeometry.vertices.length / 3,
          3,
          mergedTriangleVertices,
          mergedTriangleColors,
        )
      }
    } else {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (needsFitRef.current && w > 1 && h > 1) {
        const machineStore = useMachineStore.getState()
        const bedReady = machineStore.controllerSettings.maxTravelX != null && machineStore.controllerSettings.maxTravelY != null
        if (modelRef.current || bedReady) {
          needsFitRef.current = false
          fitToView(modelRef.current)
          return
        }
      }

      const t = transformRef.current

      ctx.clearRect(0, 0, w, h)

      drawGrid(ctx, w, h, t, units)

      drawOrigin(ctx, t)

      const store2d = useMachineStore.getState()
      const bedSettings = store2d.controllerSettings
      const bed2d = getBedEnvelope(bedSettings, store2d.status)
      if (bed2d) drawBedBoundary(ctx, t, bed2d.width, bed2d.height, bed2d.originX, bed2d.originY)

      const mdl = modelRef.current
      const store = useMachineStore.getState()
      const simulationRendering = simulationPhaseRef.current !== 'idle'
      const running = store.status.state === 'Run' || store.status.state === 'Hold' || simulationRendering

      if (!mdl) {
        if (showToolRef.current) {
          const wpos = simulationRendering ? simulationToolPosRef.current : store.status.wpos
          if (!wpos) return
          drawToolPosition(ctx, t, wpos.x, wpos.y, running)
        }
        return
      }

      const { segments } = mdl
      const progress = running ? progressRef.current : null

      // Null while a large job's paths are still being prepared.
      const staticPaths = ensureStatic2DPaths(mdl)
      if (staticPaths) drawStatic2DLayer(ctx, staticPaths, t, w, h, renderLinesRef.current?.count ?? mdl.segments.length)

      const use2DProgressOverlay = progress !== null && mdl.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT

      if (use2DProgressOverlay) {
        const completedPath = ensureProgress2DPath(mdl, progress)
        strokeModelPath(ctx, completedPath, t, CUT_DONE, 1.5)

        const currentSegment = segmentAt(segments, progress.segmentIndex)
        if (currentSegment?.moveType === 'feed' && (currentSegment.tool == null || !hiddenToolsRef.current.has(currentSegment.tool))) {
          ctx.strokeStyle = CUT_DONE
          ctx.lineWidth = 1.5
          ctx.setLineDash([])
          drawSegment(ctx, currentSegment, t, progress.fraction)
        }
      }
      ctx.setLineDash([])

      if (showToolRef.current) {
        const wpos = simulationRendering ? simulationToolPosRef.current : store.status.wpos
        if (!wpos) return
        drawToolPosition(ctx, t, wpos.x, wpos.y, running)
      }
    }
  }
  renderRef.current = render

  function centerViewOn(wx: number, wy: number) {
    const { w, h } = canvasLogicalSize()
    const t = transformRef.current
    t.ox = w / 2 - wx * t.scale
    t.oy = h / 2 + wy * t.scale
  }

  function ensureToolVisible(wx: number, wy: number) {
    const { w, h } = canvasLogicalSize()
    const t = transformRef.current
    const sx = t.ox + wx * t.scale
    const sy = t.oy - wy * t.scale
    // Once the tool nears an edge, bring it back to the middle so the path
    // ahead stays in view, instead of keeping it pinned to that edge.
    const margin = Math.max(FOLLOW_EDGE_MARGIN_PX, Math.min(w, h) * FOLLOW_EDGE_MARGIN_RATIO)
    if (sx < margin || sx > w - margin || sy < margin || sy > h - margin) centerViewOn(wx, wy)
  }

  useEffect(() => {
    if (!model && controllerSettings.maxTravelX != null && controllerSettings.maxTravelY != null) {
      needsFitRef.current = true
      scheduleRender()
    }
  }, [
    controllerSettings.maxTravelX,
    controllerSettings.maxTravelY,
    controllerSettings.homingDirInvert,
    controllerSettings.machineMinX,
    controllerSettings.machineMaxX,
    controllerSettings.machineMinY,
    controllerSettings.machineMaxY,
    model,
    is3D,
  ])

  useEffect(() => {
    if (simulationActive) {
      prevIsRunningRef.current = isRunning
      prevModelRef.current = model
      setSenderExecutionProgressPercent(null)
      scheduleRender()
      return
    }

    if (isRunning && modelRef.current) {
      const progressOverlayEnabled = modelRef.current.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT

      const freshStart = !prevIsRunningRef.current || model !== prevModelRef.current
      if (!progressOverlayEnabled) {
        progressRef.current = null
      } else if (senderActive) {
        const acceptedSegmentIndex = senderAcceptedLine == null
          ? -1
          : findLastSegmentAtOrBeforeSourceLine(modelRef.current.segments, senderAcceptedLine)
        progressRef.current = findToolpathProgress(
          modelRef.current.segments,
          ensureCumulativeXYLengths(modelRef.current),
          status.wpos.x,
          status.wpos.y,
          status.wpos.z,
          progressRef.current,
          getLookaheadDistanceMm(status.feed),
          acceptedSegmentIndex,
        )
      } else if (freshStart) {
        progressRef.current = { segmentIndex: 0, fraction: 0 }
      } else {
        progressRef.current = findToolpathProgress(
          modelRef.current.segments,
          ensureCumulativeXYLengths(modelRef.current),
          status.wpos.x,
          status.wpos.y,
          status.wpos.z,
          progressRef.current,
          getLookaheadDistanceMm(status.feed),
        )
      }
    } else {
      progressRef.current = null
    }
    const trackedProgress = progressRef.current
    const trackedModel = modelRef.current
    if (senderActive) {
      if (trackedProgress && trackedModel) {
        const cumulative = ensureCumulativeXYLengths(trackedModel)
        const totalLength = cumulative[cumulative.length - 1]
        const segment = segmentAt(trackedModel.segments, trackedProgress.segmentIndex)
        const completedLength = cumulative[trackedProgress.segmentIndex]
          + (segment ? segmentXYLength(segment) * trackedProgress.fraction : 0)
        setSenderExecutionProgressPercent(totalLength > 0 ? clamp01(completedLength / totalLength) * 100 : 0)
      } else {
        setSenderExecutionProgressPercent(0)
      }
    } else {
      setSenderExecutionProgressPercent(null)
    }
    setActiveSourceLine(
      trackedProgress && trackedModel
        ? segmentAt(trackedModel.segments, trackedProgress.segmentIndex)?.sourceLine ?? null
        : null,
    )
    prevIsRunningRef.current = isRunning
    prevModelRef.current = model

    if (isRunning && autoFollow && showTool) {
      ensureToolVisible(status.wpos.x, status.wpos.y)
    }
    scheduleRender()
  }, [
    model,
    simulationActive,
    showRapids,
    showTool,
    hiddenTools,
    isRunning,
    senderActive,
    senderAcceptedLine,
    autoFollow,
    status.wpos.x,
    status.wpos.y,
    status.wpos.z,
    status.wco.x,
    status.wco.y,
    status.feed,
    controllerSettings.maxTravelX,
    controllerSettings.maxTravelY,
    controllerSettings.homingDirInvert,
    controllerSettings.machineMinX,
    controllerSettings.machineMaxX,
    controllerSettings.machineMinY,
    controllerSettings.machineMaxY,
    units,
    is3D,
    setActiveSourceLine,
  ])

  useEffect(() => () => setActiveSourceLine(null), [setActiveSourceLine])

  useEffect(() => () => {
    cancelSimulationFrame()
    if (simulationStopTimerRef.current) window.clearTimeout(simulationStopTimerRef.current)
  }, [])

  useLayoutEffect(() => {
    if (is3D) {
      updateCameraFromOrbit()
      renderRef.current()
    }
  }, [orbitState, is3D, projectionMode])

  useEffect(() => {
    if (is3D && !rendererRef.current) {
      initWebGLRenderer()
    }
  }, [is3D])

  useEffect(() => {
    const container = containerRef.current
    const canvas2d = canvasRef.current
    const canvasWebgl = webglCanvasRef.current
    if (!container) return

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1

      if (canvas2d) {
        canvas2d.width = rect.width * dpr
        canvas2d.height = rect.height * dpr
        canvas2d.style.width = `${rect.width}px`
        canvas2d.style.height = `${rect.height}px`
        const ctx = canvas2d.getContext('2d')
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      if (canvasWebgl) {
        canvasWebgl.width = rect.width * dpr
        canvasWebgl.height = rect.height * dpr
        canvasWebgl.style.width = `${rect.width}px`
        canvasWebgl.style.height = `${rect.height}px`
      }

      scheduleRender()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      e.stopPropagation()

      const zoomScale = getWheelZoomScale(e.deltaY, e.deltaMode, container!.clientHeight)

      if (is3D) {
        const anchor = getScreenAnchor(e.clientX, e.clientY)
        setOrbitState(prev => zoomOrbitTowardAnchor(prev, 1 / zoomScale, anchor))
      } else {
        const t = transformRef.current
        const rect = container!.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        t.ox = mx - (mx - t.ox) * zoomScale
        t.oy = my - (my - t.oy) * zoomScale
        t.scale *= zoomScale
        scheduleRender()
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [is3D, projectionMode])

  function onPointerDown(e: React.PointerEvent) {
    if (is3D) e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const pointerDragMode = is3D && (e.button === 1 || e.button === 2 || e.shiftKey) ? 'pan' : dragMode
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, dragMode: pointerDragMode })

    if (activePointersRef.current.size === 1) {
      if (is3D) {
        start3DDrag(e.clientX, e.clientY, pointerDragMode)
      } else {
        const t = transformRef.current
        dragRef.current = { sx: e.clientX, sy: e.clientY, ox: t.ox, oy: t.oy }
      }
    } else {
      dragRef.current = null
      orbitDragRef.current = null
      panDragRef.current = null
      lastPinchDistRef.current = null
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const activePointer = activePointersRef.current.get(e.pointerId)
    if (!activePointer) return
    activePointersRef.current.set(e.pointerId, { ...activePointer, x: e.clientX, y: e.clientY })
    const pointers = Array.from(activePointersRef.current.values())

    if (pointers.length === 2) {
      const [p1, p2] = pointers
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const centerX = (p1.x + p2.x) / 2
      const centerY = (p1.y + p2.y) / 2
      if (lastPinchDistRef.current !== null) {
        const factor = dist / lastPinchDistRef.current

        if (is3D) {
          const smoothFactor = 1 + (factor - 1) * 0.5
          const anchor = getScreenAnchor(centerX, centerY)
          setOrbitState(prev => zoomOrbitTowardAnchor(prev, 1 / smoothFactor, anchor))
        } else {
          const t = transformRef.current
          const rect = containerRef.current!.getBoundingClientRect()
          const mx = centerX - rect.left
          const my = centerY - rect.top
          t.ox = mx - (mx - t.ox) * factor
          t.oy = my - (my - t.oy) * factor
          t.scale *= factor
        }

        scheduleRender()
      }
      lastPinchDistRef.current = dist
    } else if (pointers.length === 1) {
      if (is3D && orbitDragRef.current) {
        const d = orbitDragRef.current
        const viewportHeight = Math.max(containerRef.current?.clientHeight ?? 0, 1)
        const sensitivity = (TAU * ORBIT_ROTATIONS_PER_VIEWPORT) / viewportHeight
        const deltaTheta = -(e.clientX - d.x) * sensitivity
        const deltaPhi = -(e.clientY - d.y) * sensitivity
        d.x = e.clientX
        d.y = e.clientY

        setOrbitState(prev => ({
          ...prev,
          theta: prev.theta + deltaTheta,
          phi: Math.max(
            ORBIT_POLAR_EPSILON,
            Math.min(Math.PI - ORBIT_POLAR_EPSILON, prev.phi + deltaPhi),
          ),
        }))
        scheduleRender()
      } else if (is3D && panDragRef.current) {
        const d = panDragRef.current
        const dx = (e.clientX - d.sx) * d.worldUnitsPerPixel
        const dy = (e.clientY - d.sy) * d.worldUnitsPerPixel

        setOrbitState(prev => ({
          ...prev,
          target: addVectors(
            d.target,
            addVectors(scaleVector(d.right, -dx), scaleVector(d.screenUp, dy)),
          ),
        }))
        scheduleRender()
      } else if (!is3D && dragRef.current) {
        const d = dragRef.current
        const t = transformRef.current
        t.ox = d.ox + (e.clientX - d.sx)
        t.oy = d.oy + (e.clientY - d.sy)
        scheduleRender()
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    activePointersRef.current.delete(e.pointerId)
    lastPinchDistRef.current = null

    if (activePointersRef.current.size === 1) {
      const [remaining] = Array.from(activePointersRef.current.values())
      if (is3D) {
        start3DDrag(remaining.x, remaining.y, remaining.dragMode)
      } else {
        const t = transformRef.current
        dragRef.current = { sx: remaining.x, sy: remaining.y, ox: t.ox, oy: t.oy }
      }
    } else if (activePointersRef.current.size === 0) {
      dragRef.current = null
      orbitDragRef.current = null
      panDragRef.current = null
    }
  }

  const loadFromText = useGCodeStore(s => s.loadFromText)

  async function loadLocalFile(file: File) {
    if (isRunning) return
    if (!isGCodeFileName(file.name)) return
    const text = await file.text()
    await loadFromText(text, file.name)
    needsFitRef.current = true
  }

  function getDraggedFileStatus(dataTransfer: DataTransfer): 'valid' | 'invalid' | 'unknown' {
    const files = Array.from(dataTransfer.files ?? [])
    if (files.length) return isGCodeFileName(files[0].name) ? 'valid' : 'invalid'

    const fileItems = Array.from(dataTransfer.items ?? []).filter(item => item.kind === 'file')
    // Safari intentionally withholds both files and items until the actual
    // drop. The filename cannot be checked yet, but rejecting the drag here
    // prevents Safari from delivering the drop event at all.
    if (!fileItems.length) return 'unknown'

    const namedFiles = fileItems
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file && !!file.name)
    if (!namedFiles.length) return 'unknown'
    return isGCodeFileName(namedFiles[0].name) ? 'valid' : 'invalid'
  }

  function hasDraggedFiles(dataTransfer: DataTransfer) {
    // Array.from also supports Safari's legacy DOMStringList implementation.
    return Array.from(dataTransfer.types ?? []).includes('Files')
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file || !isGCodeFileName(file.name)) {
      setFileDragStatus('invalid')
      window.setTimeout(() => setFileDragStatus('idle'), 2000)
      return
    }
    setFileDragStatus('idle')
    void loadLocalFile(file)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    if (hasDraggedFiles(e.dataTransfer)) {
      const status = getDraggedFileStatus(e.dataTransfer)
      e.dataTransfer.dropEffect = status !== 'invalid' && !isRunning ? 'copy' : 'none'
      setFileDragStatus(status)
    }
  }

  function startLocalSenderWithWarning() {
    if (!sourceText || !fileName) return
    if (localStorage.getItem(LOCAL_SENDER_WARNING_ACK_KEY) === 'true') {
      if (startSender(sourceText, fileName)) startTrackedJob('local')
      return
    }
    setShowLocalSenderWarning(true)
  }

  function confirmLocalSenderWarning() {
    if (!sourceText || !fileName) return
    localStorage.setItem(LOCAL_SENDER_WARNING_ACK_KEY, 'true')
    setShowLocalSenderWarning(false)
    if (startSender(sourceText, fileName)) startTrackedJob('local')
  }

  useEffect(() => {
    setFramingFeedInput(formatInputValue(mmToDisplay(getStoredPositiveNumber(FRAMING_FEED_KEY, 1000), units), units === 'in' ? 2 : 0))
    setFramingClearanceInput(formatInputValue(mmToDisplay(getStoredFiniteNumber(FRAMING_CLEARANCE_KEY, 5), units), units === 'in' ? 3 : 1))
    setFramingTravelZInput(formatInputValue(mmToDisplay(getStoredFiniteNumber(FRAMING_TRAVEL_Z_KEY, 5), units), units === 'in' ? 3 : 1))
  }, [units])

  function updateFramingMode(mode: FramingMode) {
    setFramingMode(mode)
    localStorage.setItem(FRAMING_MODE_KEY, mode)
    setFramingError(null)
  }

  function openFramingDialog() {
    if (model) {
      const clearanceDisplay = Number.parseFloat(framingClearanceInput)
      const travelZDisplay = Number.parseFloat(framingTravelZInput)
      if (Number.isFinite(clearanceDisplay)) {
        const requiredTravelZMm = getFramingRequiredTravelZ(model, displayToMm(clearanceDisplay, units))
        const currentTravelZMm = Number.isFinite(travelZDisplay) ? displayToMm(travelZDisplay, units) : -Infinity
        if (requiredTravelZMm != null && currentTravelZMm < requiredTravelZMm) {
          setFramingTravelZInput(formatCeilInputValue(mmToDisplay(requiredTravelZMm, units), units === 'in' ? 3 : 1))
        }
      }
    }
    setFramingError(null)
    setShowFramingDialog(true)
  }

  function startFramingRoutine() {
    if (!model) return
    const feedDisplay = Number.parseFloat(framingFeedInput)
    const clearanceDisplay = Number.parseFloat(framingClearanceInput)
    const travelZDisplay = Number.parseFloat(framingTravelZInput)
    if (!Number.isFinite(feedDisplay) || feedDisplay <= 0) {
      setFramingError('Enter a framing feed rate greater than zero.')
      return
    }
    if (!Number.isFinite(clearanceDisplay)) {
      setFramingError('Enter a valid clearance height.')
      return
    }
    if (!Number.isFinite(travelZDisplay)) {
      setFramingError('Enter a valid safe travel height.')
      return
    }

    const feedMmPerMin = displayToMm(feedDisplay, units)
    const clearanceMm = displayToMm(clearanceDisplay, units)
    const travelZMm = displayToMm(travelZDisplay, units)
    let result: string | null
    try {
      result = buildFramingGCode(model, {
        mode: framingMode,
        feedMmPerMin,
        clearanceMm,
        travelZMm,
        displayUnits: units,
      })
    } catch (error) {
      setFramingError(error instanceof Error ? error.message : 'Framing settings are not valid.')
      return
    }
    if (!result) {
      setFramingError('This file has no cutting moves to frame.')
      return
    }

    localStorage.setItem(FRAMING_MODE_KEY, framingMode)
    localStorage.setItem(FRAMING_FEED_KEY, String(feedMmPerMin))
    localStorage.setItem(FRAMING_CLEARANCE_KEY, String(clearanceMm))
    localStorage.setItem(FRAMING_TRAVEL_Z_KEY, String(travelZMm))
    const started = startSender(
      result,
      `${fileName ?? 'job'} ${framingMode === 'rectangle' ? 'rectangle' : 'contour'} frame`,
      { showRuntimeEstimate: false },
    )
    if (!started) {
      setFramingError('Framing can start only while connected and idle.')
      return
    }
    setShowFramingDialog(false)
    setFramingError(null)
  }

  const isFileDragging = fileDragStatus !== 'idle'
  const isValidFileDragging = (fileDragStatus === 'valid' || fileDragStatus === 'unknown') && !isRunning
  const hasLoadedSource = !!sourceText && !!fileName
  const toolList = model?.tools ?? []
  const showToolPathControls = toolList.length > 1
  const visibleToolCount = showToolPathControls ? toolList.length - hiddenTools.size : 0

  function toggleToolPath(tool: number) {
    setHiddenTools(prev => {
      const next = new Set(prev)
      if (next.has(tool)) next.delete(tool)
      else next.add(tool)
      return next
    })
    progress2DPathRef.current = null
    scheduleRender()
  }

  const VCX = 54, VCY = 54, CUBE_S = 19
  const viewCubeData = is3D ? get3DViewCubeData(orbitState, cameraRef.current.up, VCX, VCY, CUBE_S) : null

  return (
    <div className={`panel flex flex-col overflow-hidden ${className ?? ''}`}>
      <div className="panel-header !flex-col !items-stretch sm:!flex-row sm:!items-center sm:justify-between gap-y-1.5">
        {!isTablet && (
        <div className="flex items-center gap-2 min-w-0 sm:flex-1">
          {fileName ? (
            <span
              className="text-text-primary font-mono normal-case tracking-normal font-normal truncate text-sm min-w-0"
              title={fileName}
            >
              {fileName}
            </span>
          ) : (
            <span className="text-text-dim text-sm whitespace-nowrap">No file loaded</span>
          )}
          {isLocalFile && <span className="tag border-info/30 bg-info/10 text-info normal-case tracking-normal">Local</span>}
          {restartSource && (
            <span className="px-1.5 py-0.5 rounded text-xs font-semibold text-accent bg-accent/10 border border-accent/25 shrink-0" title={`Prepared from ${restartSource.fileName}, requested line ${restartSource.requestedLine}`}>
              Restart L{restartSource.resumeLine}
            </span>
          )}
          {isLargeProgressOverlayDisabled && (
            <span
              className="px-1.5 py-0.5 rounded text-sm text-text-dim bg-elevated shrink-0"
              title={`Toolpath completion overlay disabled above ${LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT.toLocaleString()} segments while a job is running`}
            >
              Progress overlay off
            </span>
          )}
          {!loading && isProcessing3D && (
            <span
              className="px-1.5 py-0.5 rounded text-sm text-text-dim bg-elevated shrink-0"
              title="3D preview is still being prepared in the background"
            >
              3D {processing3DProgress}%
            </span>
          )}
        </div>
        )}
        {/* Right: toggle buttons with visible labels */}
        <div className="flex items-center gap-1 flex-wrap sm:flex-nowrap justify-start sm:justify-end ml-auto sm:shrink-0">
          <input
            ref={localFileInputRef}
            type="file"
            className="hidden"
            accept={GCODE_ACCEPT_ATTRIBUTE}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              if (file) void loadLocalFile(file)
              event.currentTarget.value = ''
            }}
          />
          {(() => {
            const btnCls = isTablet
              ? 'flex items-center gap-1.5 px-3 py-1.5 rounded text-base transition-colors'
              : 'flex items-center gap-1 px-1.5 py-0.5 rounded text-base transition-colors'
            const iconSize = isTablet ? 16 : 11
            return (<>
          <button
            className={`${btnCls} ${is3D ? 'text-ok bg-ok/10' : 'text-text-dim bg-elevated hover:text-text-primary'} ${is3DToggleDisabled ? 'opacity-50 cursor-not-allowed hover:text-text-dim hover:bg-elevated' : ''}`}
            onClick={() => {
              if (is3DToggleDisabled) return
              setIs3D(v => !v)
              needsFitRef.current = true
              scheduleRender()
            }}
            title={is3DToggleDisabled ? '3D preview is still being prepared' : 'Toggle 3D view'}
            disabled={is3DToggleDisabled}
          >
            <Box size={iconSize} />
            <span>3D</span>
          </button>
          {is3D && (
            <>
              <button
                className={`${btnCls} ${projectionMode === 'orthographic' ? 'text-info bg-info/10' : 'text-text-dim bg-elevated hover:text-text-primary'}`}
                onClick={() => setProjectionMode(mode => mode === 'perspective' ? 'orthographic' : 'perspective')}
                title={projectionMode === 'orthographic' ? 'Switch to perspective projection' : 'Switch to orthographic projection'}
              >
                <Axis3D size={iconSize} />
                <span>{projectionMode === 'orthographic' ? 'Ortho' : 'Persp'}</span>
              </button>
              <button
                className={`${btnCls} ${dragMode === 'pan' ? 'text-info bg-info/10' : 'text-text-dim bg-elevated hover:text-text-primary'}`}
                onClick={() => setDragMode(mode => mode === 'orbit' ? 'pan' : 'orbit')}
                title={dragMode === 'orbit'
                  ? 'Drag to orbit. Shift-, middle-, or right-drag to pan.'
                  : 'Drag to pan.'}
              >
                {dragMode === 'orbit' ? <Orbit size={iconSize} /> : <Hand size={iconSize} />}
                <span>{dragMode === 'orbit' ? 'Orbit' : 'Pan'}</span>
              </button>
            </>
          )}
          <button
            className={`${btnCls} ${showRapids ? 'text-accent bg-accent/10' : 'text-text-dim bg-elevated hover:text-text-primary'}`}
            onClick={() => setShowRapids(!showRapids)}
            title="Toggle rapid moves (dashed blue lines)"
          >
            <Eye size={iconSize} />
            <span>Rapids</span>
          </button>
          <button
            className={`${btnCls} ${showTool ? 'text-danger bg-danger/10' : 'text-text-dim bg-elevated hover:text-text-primary'}`}
            onClick={() => setShowTool(v => !v)}
            title="Toggle tool position marker"
          >
            <Crosshair size={iconSize} />
            <span>Tool</span>
          </button>
          {!is3D && (
            <button
              className={`${btnCls} ${autoFollow ? 'text-info bg-info/10' : 'text-text-dim bg-elevated hover:text-text-primary'}`}
              onClick={() => {
                const follow = !autoFollow
                setAutoFollow(follow)
                if (follow && isRunning && showTool) {
                  centerViewOn(status.wpos.x, status.wpos.y)
                  scheduleRender()
                }
              }}
              title="Keep the tool in view while running; re-centers it when it nears an edge"
            >
              <Navigation size={iconSize} />
              <span>Follow</span>
            </button>
          )}
          <button
            className={`${btnCls} text-text-muted hover:text-text-primary hover:bg-elevated`}
            onClick={() => fitToView()}
            title="Fit entire path to view"
          >
            <Maximize2 size={iconSize} />
            <span>Fit</span>
          </button>
            </>)
          })()}
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragStatus('idle')
        }}
        onContextMenu={e => { if (is3D) e.preventDefault() }}
      >
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 transition-[filter,opacity] duration-150 ${is3D ? 'hidden' : ''} ${loading || isValidFileDragging ? 'blur-[2px] opacity-40' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <canvas
          ref={webglCanvasRef}
          className={`absolute inset-0 transition-[filter,opacity] duration-150 ${!is3D ? 'hidden' : ''} ${loading || isValidFileDragging ? 'blur-[2px] opacity-40' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {isFileDragging && !isRunning && (
          <div className={`absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed pointer-events-none backdrop-blur-sm ${
            fileDragStatus !== 'invalid'
              ? 'border-info bg-surface/90'
              : 'border-danger bg-surface/95'
          }`}>
            <div className={`text-center ${fileDragStatus !== 'invalid' ? 'text-info' : 'text-danger'}`}>
              <FilePlus size={34} className="mx-auto mb-2" />
              <div className="font-semibold">
                {fileDragStatus === 'invalid'
                  ? 'Unsupported file type'
                  : 'Drop G-code to preview and stream'}
              </div>
              <div className="mt-1 text-sm text-text-muted">
                {fileDragStatus === 'invalid'
                  ? `Use ${GCODE_EXTENSIONS_PREVIEW} files.`
                  : 'The file stays in this browser.'}
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/70 backdrop-blur-sm px-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-surface/95 shadow-lg p-4 space-y-3">
              <div className="text-base text-text-primary font-mono truncate">
                {pendingFileName ?? pendingPath?.split('/').pop() ?? fileName ?? 'Loading file'}
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-base text-text-dim uppercase tracking-wide">
                  <span>{pendingPath ? 'Download from controller' : 'Read local file'}</span>
                  <span>{downloadProgress == null ? 'Streaming' : `${downloadProgress}%`}</span>
                </div>
                <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-info rounded-full transition-all duration-150 ${downloadProgress == null ? 'w-full animate-pulse' : ''}`}
                    style={downloadProgress == null ? undefined : { width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-base text-text-dim uppercase tracking-wide">
                  <span>Prepare 2D View</span>
                  <span>{processing2DProgress}%</span>
                </div>
                <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-150" style={{ width: `${processing2DProgress}%` }} />
                </div>
              </div>
              <div className="space-y-1 opacity-75">
                <div className="flex items-center justify-between text-base text-text-dim uppercase tracking-wide">
                  <span>Prepare 3D View</span>
                  <span>{processing3DProgress}%</span>
                </div>
                <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-ok rounded-full transition-all duration-150" style={{ width: `${processing3DProgress}%` }} />
                </div>
              </div>
              <div className="flex gap-2 mt-1">
                {pendingPath && (
                  <button
                    className="btn btn-warn gap-2 justify-center text-sm flex-1"
                    onClick={handleStartWithoutPreview}
                    title="Cancel the preview download and start the job immediately"
                  >
                    <Zap size={12} />
                    Start without preview
                  </button>
                )}
                <button
                  className="btn gap-2 justify-center text-sm"
                  onClick={cancelLoad}
                  title="Cancel the download"
                >
                  <Square size={12} />
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && isProcessing3D && model && (
          <div className="absolute top-3 right-3 left-3 sm:left-auto sm:w-72 bg-surface/85 backdrop-blur-sm border border-border rounded-lg px-3 py-2">
            <div className="flex items-center justify-between text-sm text-text-dim uppercase tracking-wide mb-1">
              <span>Preparing 3D View</span>
              <span>{processing3DProgress}%</span>
            </div>
            <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-ok rounded-full transition-all duration-150" style={{ width: `${processing3DProgress}%` }} />
            </div>
          </div>
        )}

        {showToolPathControls && !loading && (
          <div className={`absolute ${isProcessing3D ? 'top-20' : 'top-3'} left-3 z-20 ${showToolPathMenu ? 'w-[min(15rem,calc(100%-1.5rem))]' : 'w-auto'} pointer-events-none`}>
            <div className="pointer-events-auto inline-block w-full rounded border border-border bg-surface/80 backdrop-blur-sm p-1 shadow-sm">
              <button
                type="button"
                className={`h-8 inline-flex items-center justify-between gap-2 rounded px-2 text-xs font-semibold transition-colors ${showToolPathMenu ? 'w-full' : 'w-auto'} ${
                  showToolPathMenu
                    ? 'bg-elevated text-text-primary'
                    : 'text-text-primary hover:bg-elevated'
                }`}
                onClick={() => setShowToolPathMenu(open => !open)}
                title="Show toolpath visibility controls"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Wrench size={12} className="shrink-0 text-text-muted" />
                  <span className="text-text-muted">Tools</span>
                  <span className="font-mono tabular-nums text-text-primary">{visibleToolCount}/{toolList.length}</span>
                </span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 text-text-muted transition-transform ${showToolPathMenu ? 'rotate-180' : ''}`}
                />
              </button>
              {showToolPathMenu && (
                <div className="mt-1 flex flex-col gap-1">
                  {toolList.map(tool => {
                    const hidden = hiddenTools.has(tool.number)
                    return (
                      <button
                        key={tool.number}
                        type="button"
                        className={`h-7 w-full min-w-0 inline-flex items-center gap-1.5 rounded border px-2 text-xs font-semibold transition-colors ${
                          hidden
                            ? 'border-border bg-elevated text-text-dim opacity-60'
                            : 'border-border/80 bg-surface text-text-primary hover:border-info/60'
                        }`}
                        onClick={() => toggleToolPath(tool.number)}
                        title={`${hidden ? 'Show' : 'Hide'} ${tool.label}`}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: toolPathColor(tool.number), opacity: hidden ? 0.35 : 1 }}
                        />
                        <span className="min-w-0 truncate text-left">{tool.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {model && !isViewerStartBlocked && !machineJobActive && (
          <div className={`absolute ${isProcessing3D ? 'top-20' : 'top-3'} right-3 left-3 sm:left-auto z-20 flex justify-end pointer-events-none`}>
            {!simulationActive ? (
              <div className="pointer-events-auto flex items-center gap-1.5">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded border border-border bg-surface/80 backdrop-blur-sm px-3 py-1.5 text-sm font-semibold text-text-primary shadow-sm hover:border-info/60 hover:text-info active:bg-elevated disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text-primary"
                  onClick={openFramingDialog}
                  disabled={!connected || status.state !== 'Idle' || controllerResetPending}
                  title={!connected || status.state !== 'Idle' || controllerResetPending ? 'Wait for the controller to be ready before framing' : 'Frame the cutting extents at clearance height'}
                >
                  <Maximize size={14} />
                  Frame
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded border border-border bg-surface/80 backdrop-blur-sm px-3 py-1.5 text-sm font-semibold text-text-primary shadow-sm hover:border-accent/60 hover:text-accent active:bg-elevated"
                  onClick={startSimulation}
                  title="Preview the toolpath motion without sending commands"
                >
                  <Play size={14} />
                  Simulate
                </button>
              </div>
            ) : (
              <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1.5 rounded border border-border bg-surface/80 backdrop-blur-sm px-2 py-1.5 shadow-sm">
                <span className="hidden sm:inline px-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">Simulation</span>
                <div className="flex items-center gap-1" title="Simulation playback speed">
                  <button
                    type="button"
                    className="h-8 w-8 rounded border border-border bg-elevated text-base text-text-primary hover:border-accent/60 disabled:opacity-40"
                    onClick={() => setSimulationSpeedPercentClamped(simulationSpeedPercent - SIMULATION_SPEED_STEP)}
                    disabled={simulationSpeedPercent <= SIMULATION_SPEED_MIN}
                    aria-label="Decrease simulation speed"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className={`h-8 min-w-14 rounded border border-border bg-elevated px-2 font-mono text-sm font-semibold ${simulationSpeedPercent === 100 ? 'text-accent' : simulationSpeedPercent > 100 ? 'text-ok' : 'text-warn'}`}
                    onClick={() => setSimulationSpeedPercentClamped(100)}
                    title="Reset simulation speed to 100%"
                  >
                    {simulationSpeedPercent}%
                  </button>
                  <button
                    type="button"
                    className="h-8 w-8 rounded border border-border bg-elevated text-base text-text-primary hover:border-accent/60 disabled:opacity-40"
                    onClick={() => setSimulationSpeedPercentClamped(simulationSpeedPercent + SIMULATION_SPEED_STEP)}
                    disabled={simulationSpeedPercent >= SIMULATION_SPEED_MAX}
                    aria-label="Increase simulation speed"
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  className={`h-8 rounded border px-2.5 text-sm font-semibold ${simulationPaused ? 'border-ok/40 bg-ok/10 text-ok' : 'border-warning/40 bg-warning/10 text-warning'} disabled:opacity-50`}
                  onClick={simulationPaused ? resumeSimulation : pauseSimulation}
                  disabled={simulationPhase === 'completed'}
                  title={simulationPaused ? 'Resume preview simulation' : 'Pause preview simulation'}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {simulationPaused ? <Play size={13} /> : <Pause size={13} />}
                    {simulationPaused ? 'Resume' : 'Pause'}
                  </span>
                </button>
                <button
                  type="button"
                  className="h-8 rounded border border-border bg-elevated px-2.5 text-sm font-semibold text-text-primary hover:border-danger/50 hover:text-danger"
                  onClick={() => stopSimulation()}
                  title="Stop preview simulation"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Square size={13} />
                    Stop
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        {!model && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-text-dim text-2xl gap-2">
            <Eye size={24} className="opacity-30" />
            <span>Click a G-code file to preview</span>
          </div>
        )}

        {model && (
          <div className="absolute bottom-2 right-2 flex items-center gap-3 bg-surface/80 backdrop-blur-sm
                          rounded px-2 py-1 pointer-events-none select-none">
            <span className="flex items-center gap-1.5 text-sm text-text-dim">
              <span className="inline-block w-5 h-px border-t-2 border-dashed border-[rgba(100,120,160,0.6)]" />
              Rapid
            </span>
            <span className="flex items-center gap-1.5 text-sm text-text-dim">
              <span className="inline-block w-5 h-0.5 bg-[#f0a030] rounded" />
              Cut
            </span>
            <span className="flex items-center gap-1.5 text-sm text-text-dim">
              <span className="inline-block w-5 h-0.5 bg-[#22c55e] rounded" />
              Done
            </span>
          </div>
        )}

        {is3D ? (
          <svg
            className="absolute bottom-3 left-3 select-none"
            width="108"
            height="108"
            viewBox="0 0 108 108"
            style={{ overflow: 'visible' }}
            role="group"
            aria-label="3D view orientation"
          >
            {viewCubeData?.faces.map(face => {
              const points = face.projectedCorners.map(p => `${p.x},${p.y}`).join(' ')
              const visF = (-face.depth + 1) / 2
              const fillAlpha = 0.38 + visF * 0.38
              const targetId = `face-${face.label}`
              const isHovered = hoveredViewTarget === targetId
              return (
                <g key={face.label}>
                  <title>{`View ${face.label}`}</title>
                  <polygon
                    points={points}
                    fill={isHovered ? 'rgba(42, 194, 156, 0.88)' : `rgba(170, 176, 186, ${fillAlpha})`}
                    stroke={isHovered ? 'rgba(208, 255, 241, 0.98)' : 'rgba(92, 98, 108, 0.72)'}
                    strokeWidth={isHovered ? '1.3' : '0.9'}
                    strokeLinejoin="round"
                    style={{ cursor: face.isVisible ? 'pointer' : 'default', pointerEvents: face.isVisible ? 'auto' : 'none' }}
                    onClick={face.isVisible ? () => snapOrbitToView(face.snapTheta, face.snapPhi) : undefined}
                    onMouseEnter={face.isVisible ? () => setHoveredViewTarget(targetId) : undefined}
                    onMouseLeave={face.isVisible ? () => setHoveredViewTarget(null) : undefined}
                  />
                  {face.isVisible && (
                    <text
                      transform={face.labelTransform}
                      x="0"
                      y="0.08"
                      fontSize="0.55"
                      fill="rgba(34, 38, 45, 0.88)"
                      fontFamily="ui-sans-serif,system-ui,sans-serif"
                      fontWeight="600"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {face.label}
                    </text>
                  )}
                </g>
              )
            })}

            {viewCubeData?.cornerFacets.map(facet => {
              const targetId = `corner-${facet.label}`
              const isHovered = hoveredViewTarget === targetId
              return facet.isVisible && (
                <g key={facet.label}>
                  <title>{`View isometric ${facet.label}`}</title>
                  <polygon
                    points={facet.projectedCorners.map(point => `${point.x},${point.y}`).join(' ')}
                    fill={isHovered ? 'rgba(42, 194, 156, 0.94)' : 'rgba(218, 225, 234, 0.8)'}
                    stroke={isHovered ? 'rgba(208, 255, 241, 0.98)' : 'rgba(92, 98, 108, 0.72)'}
                    strokeWidth={isHovered ? '1.3' : '0.9'}
                    strokeLinejoin="round"
                    style={{ cursor: 'pointer' }}
                    onClick={() => snapOrbitToView(facet.snapTheta, facet.snapPhi)}
                    onMouseEnter={() => setHoveredViewTarget(targetId)}
                    onMouseLeave={() => setHoveredViewTarget(null)}
                  />
                </g>
              )
            })}

            <g style={{ pointerEvents: 'none' }}>
              {viewCubeData && <circle cx={viewCubeData.axisOrigin.x} cy={viewCubeData.axisOrigin.y} r="2.5" fill="rgba(240,160,48,0.92)" />}
              {viewCubeData?.axisVectors.map(axis => {
                const opacity = 0.35 + ((1 - axis.depth) / 2) * 0.65
                return (
                  <g key={axis.label} opacity={opacity}>
                    <line x1={axis.start.x} y1={axis.start.y} x2={axis.end.x} y2={axis.end.y} stroke={axis.color} strokeWidth="2.2" strokeLinecap="round" />
                    <polygon points={getArrowHeadPoints(axis.start.x, axis.start.y, axis.end.x, axis.end.y, 5.5)} fill={axis.color} />
                    <text
                      x={axis.labelPosition.x}
                      y={axis.labelPosition.y + 3.5}
                      fontSize="9.5"
                      fill={axis.color}
                      fontFamily="ui-monospace,monospace"
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {axis.label}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>
        ) : (
          <svg
            className="absolute bottom-3 left-3 pointer-events-none select-none"
            width="76"
            height="76"
            viewBox="0 0 76 76"
            aria-hidden="true"
          >
            <line x1="20" y1="56" x2="50" y2="56" stroke={AXIS_X_COLOR} strokeWidth="2.4" strokeLinecap="round" />
            <polygon points={getArrowHeadPoints(20, 56, 50, 56, 6)} fill={AXIS_X_COLOR} />
            <line x1="20" y1="56" x2="20" y2="26" stroke={AXIS_Y_COLOR} strokeWidth="2.4" strokeLinecap="round" />
            <polygon points={getArrowHeadPoints(20, 56, 20, 26, 6)} fill={AXIS_Y_COLOR} />
            <circle cx="20" cy="56" r="3" fill="rgba(240,160,48,0.9)" />
            <text x="58" y="60" fontSize="10" fill={AXIS_X_COLOR} fontFamily="ui-monospace,monospace" fontWeight="700">X</text>
            <text x="16" y="18" fontSize="10" fill={AXIS_Y_COLOR} fontFamily="ui-monospace,monospace" fontWeight="700">Y</text>
          </svg>
        )}
      </div>

      {/* Permanent bottom strip */}
      <div className="shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3 flex flex-col gap-2">
        {/* Progress bar — only while a job is active */}
        {(isJobRunning || isJobHeld || simulationActive) && (
          <div className="flex flex-col gap-1.5">
            {controllerJobStarting && (
              <div className="flex items-center gap-2 text-[11px] font-mono text-text-muted" role="status" aria-live="polite">
                <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" />
                Starting job - waiting for spindle spin-up.
              </div>
            )}
            {displayedProgressPercent != null && (
              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-ok transition-all duration-500 rounded-full" style={{ width: `${displayedProgressPercent}%` }} />
                </div>
                {simulationActive && (
                  <span className="text-[11px] font-mono text-text-muted tabular-nums" title="Preview-only simulation; no commands are being sent">
                    Simulation {Math.round(displayedProgressPercent)}%
                  </span>
                )}
                {senderActive && (
                  <span className="text-[11px] font-mono text-text-muted tabular-nums" title="Position-derived toolpath completion, bounded by the latest accepted line">
                    Motion {Math.round(displayedProgressPercent)}%
                  </span>
                )}
              </div>
            )}
            {showDisplayedTiming && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-text-muted tabular-nums">
                <div className="flex items-center justify-between gap-3 min-w-[220px] flex-1">
                  <span>Elapsed {formatRuntime(displayedElapsedSeconds)}</span>
                  <span>Remain {formatRuntime(displayedRemainingSeconds)}</span>
                  <span>Total {formatRuntime(displayedTotalSeconds)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {showOverrides && !simulationActive && (
          <div className="flex gap-2">
            <ViewerOverrideControl
              label="Feed"
              value={status.feedOverride}
              onMinus={() => sendRealtime(0x92)}
              onReset={() => sendRealtime(0x90)}
              onPlus={() => sendRealtime(0x91)}
            />
            <ViewerOverrideControl
              label="Speed"
              value={status.spindleOverride}
              onMinus={() => sendRealtime(0x9B)}
              onReset={() => sendRealtime(0x99)}
              onPlus={() => sendRealtime(0x9A)}
            />
          </div>
        )}

        {finishedJobElapsedMs != null && (
          <div className="rounded border border-ok/40 bg-ok/10 px-3 py-2" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ok">
                Job finished in <span className="font-mono font-semibold">{formatRuntime(finishedJobElapsedMs / 1000)}</span>
              </span>
              <button
                className="text-text-dim hover:text-text-primary"
                onClick={dismissFinishedJobNotice}
                aria-label="Dismiss job finished message"
                title="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}
        {(senderPhase === 'error') && (
          <div className={`rounded border px-3 py-2 ${senderPhase === 'error' ? 'border-danger/40 bg-danger/10' : 'border-info/30 bg-info/5'}`}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className={senderPhase === 'error' ? 'text-danger' : 'text-text-primary'}>
                {senderError ?? 'Local sender stopped'}
              </span>
              {!senderActive && (
                <button className="text-text-dim hover:text-text-primary" onClick={dismissSender} title="Dismiss">
                  <X size={14} />
                </button>
              )}
            </div>
            {senderPhase === 'error' && senderFailureLine != null && (
              <div className="mt-1 text-xs font-mono text-text-muted">
                {senderFailureLineSource === 'position' ? 'Last tracked line' : 'Last acknowledged line'}: {senderFailureLine}
              </div>
            )}
            {senderPhase === 'error' && senderFailureLine != null && senderFailureLineSource === 'position' && sourceText && fileName && (
              <button
                type="button"
                className="mt-2 btn btn-ghost px-2.5 py-1.5 text-xs gap-1.5"
                onClick={() => { setRestartInitialLine(senderFailureLine); setShowRestartFromLine(true) }}
                title="Open the restart editor at the last position-tracked program line"
              >
                <ListStart size={13} /> Review restart at line {senderFailureLine}
              </button>
            )}
            {senderNotice && (
              <div className="mt-2 text-[11px] text-warning">{senderNotice}</div>
            )}
          </div>
        )}
        {senderPhase === 'streaming' && senderNotice && (
          <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            {senderNotice}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        {!simulationActive && (controllerSettings.hasMist || controllerSettings.hasFlood) && <>
          <div className="flex gap-1.5 sm:flex-[6]">
            {controllerSettings.hasMist && <button
              onClick={() => { sendRealtime(0xA1); setCoolantState('mist') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'mist' ? 'border-accent/50 text-accent' : 'btn-ghost'}`}
            >
              <CloudDrizzle size={isTablet ? 18 : 13} />
              Mist
            </button>}
            {controllerSettings.hasFlood && <button
              onClick={() => { sendRealtime(0xA0); setCoolantState('flood') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'flood' ? 'border-info/50 text-info' : 'btn-ghost'}`}
            >
              <Waves size={isTablet ? 18 : 13} />
              Flood
            </button>}
            <button
              onClick={() => { if (sendRaw('M9')) setCoolantState('off') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'off' ? 'border-danger/50 text-danger' : 'btn-ghost'}`}
            >
              <PowerOff size={isTablet ? 18 : 13} />
              Off
            </button>
          </div>
          <div className="hidden sm:block w-px bg-border self-stretch" />
        </>}

        <div className={`flex gap-1.5 ${(controllerSettings.hasMist || controllerSettings.hasFlood) ? 'sm:flex-[3]' : 'sm:ml-auto'}`}>
          {!isJobRunning && !isJobHeld && !simulationActive && (
            <button
              className={`btn btn-ghost justify-center shrink-0 ${isTablet ? 'px-3 py-3' : 'px-2'}`}
              onClick={() => localFileInputRef.current?.click()}
              disabled={isRunning}
              title="Open a G-code file from this device"
              aria-label="Open a G-code file from this device"
            >
              <FilePlus size={isTablet ? 22 : 17} />
            </button>
          )}
          {!isJobRunning && !isJobHeld && !simulationActive && restartSource && (
            <button
              className={`btn btn-ghost gap-1.5 justify-center ${isTablet ? 'text-xl py-3' : 'text-sm'}`}
              onClick={() => restartSource.path
                ? loadFile(restartSource.path)
                : restartSource.sourceText && loadFromText(restartSource.sourceText, restartSource.fileName)}
              disabled={isViewerStartBlocked || (!restartSource.path && !restartSource.sourceText)}
              title={`Return to ${restartSource.fileName}`}
            >
              <RotateCcw size={isTablet ? 18 : 14} />
              Original
            </button>
          )}
          {!isJobRunning && !isJobHeld && !simulationActive && !restartSource && hasLoadedSource && (
            <button
              className={`btn btn-ghost gap-1.5 justify-center ${isTablet ? 'text-xl py-3' : 'text-sm'}`}
              onClick={() => { setRestartInitialLine(null); setShowRestartFromLine(true) }}
              disabled={isViewerStartBlocked}
              title={isLocalFile ? 'Prepare a safe local stream that resumes from a file line' : 'Prepare a reviewable SD-card program that restarts from a file line'}
            >
              <ListStart size={isTablet ? 18 : 14} />
              From line
            </button>
          )}
          {!isJobRunning && !isJobHeld && !simulationActive && (
            <button
              className={`btn btn-ok-solid gap-2 justify-center font-bold ${isTablet ? 'text-xl py-3' : 'text-base'} flex-1`}
              onClick={() => {
                if (isLocalFile) startLocalSenderWithWarning()
                else if (loadedPath && sendRaw(`$SD/Run=${loadedPath}`)) startTrackedJob('controller')
              }}
              disabled={(!loadedPath && !isLocalFile) || !connected || status.state !== 'Idle' || isViewerStartBlocked}
              title={isViewerStartBlocked
                ? controllerResetPending
                  ? 'Controller is resetting after the abort'
                  : sdUploadPath
                    ? 'Wait for the SD-card upload to finish before starting the job'
                    : 'Wait for file processing to finish before starting the job'
                : isLocalFile ? 'Stream this local file to FluidNC' : 'Start job from loaded controller file'}
            >
              <Play size={isTablet ? 18 : 14} />
              Start
            </button>
          )}
          {isJobRunning && (
            <button
              className={`btn btn-warn-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`}
              onClick={() => senderActive ? pauseSender() : sendRealtime(0x21)}
              title={controllerJobStarting ? 'Request a feed hold while the job starts' : undefined}
            >
              <Pause size={isTablet ? 18 : 13} />
              Pause
            </button>
          )}
          {isJobHeld && (
            <button
              className={`btn btn-ok-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`}
              onClick={() => senderPhase === 'paused' ? resumeSender() : sendRealtime(0x7e)}
              disabled={senderPhase === 'paused' && status.state === 'Door'}
              title={senderPhase === 'paused' && status.state === 'Door' ? 'Close the safety door before resuming' : undefined}
            >
              <Play size={isTablet ? 18 : 13} />
              Resume
            </button>
          )}
          {(isJobRunning || isJobHeld) && (
            <button
              className={`btn btn-danger-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`}
              onClick={() => {
                if (senderActive) abortSender()
                else {
                  if (sendRealtime(0x18)) cancelTrackedJob('controller')
                }
              }}
            >
              <Square size={isTablet ? 18 : 13} />
              Abort
            </button>
          )}
        </div>
        </div>
        {isTablet && (
          <div className="flex items-center gap-2 min-w-0 pt-1 border-t border-border">
            {fileName ? (
              <>
                <span className="text-text-primary font-mono normal-case tracking-normal font-normal truncate text-base">
                  {fileName}
                </span>
                {restartSource && (
                  <span className="px-1.5 py-0.5 rounded text-sm font-semibold text-accent bg-accent/10 border border-accent/25 shrink-0">
                    Restart L{restartSource.resumeLine}
                  </span>
                )}
              </>
            ) : (
              <span className="text-text-dim text-base">No file loaded</span>
            )}
            {isLargeProgressOverlayDisabled && (
              <span
                className="px-1.5 py-0.5 rounded text-sm text-text-dim bg-elevated shrink-0"
                title={`Toolpath completion overlay disabled above ${LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT.toLocaleString()} segments while a job is running`}
              >
                Progress overlay off
              </span>
            )}
            {!loading && isProcessing3D && (
              <span
                className="px-1.5 py-0.5 rounded text-sm text-text-dim bg-elevated shrink-0"
                title="3D preview is still being prepared in the background"
              >
                3D {processing3DProgress}%
              </span>
            )}
          </div>
        )}
      </div>
      {showRestartFromLine && sourceText && fileName && (
        <RestartFromLineDialog
          sourceText={sourceText}
          sourcePath={loadedPath}
          sourceName={fileName}
          initialLine={restartInitialLine}
          defaultSafeMachineZMm={safeMachineZ}
          onPrepared={senderPhase === 'error' ? dismissSender : undefined}
          onClose={() => { setShowRestartFromLine(false); setRestartInitialLine(null) }}
        />
      )}
      {showFramingDialog && model && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-3 sm:p-6" onClick={() => setShowFramingDialog(false)}>
          <form
            className="w-full max-w-md rounded-lg border border-border bg-surface shadow-2xl animate-in"
            onSubmit={event => {
              event.preventDefault()
              startFramingRoutine()
            }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2 text-lg font-semibold text-text-primary">
                <Maximize size={19} className="shrink-0 text-info" />
                Frame job
              </div>
              <button
                type="button"
                className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated"
                onClick={() => setShowFramingDialog(false)}
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 px-4 py-4">
              <div className="grid grid-cols-2 gap-1 rounded border border-border bg-elevated p-1">
                {(['rectangle', 'contour'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded px-3 py-2 text-sm font-semibold transition-colors ${framingMode === mode ? 'bg-info/15 text-info' : 'text-text-muted hover:text-text-primary'}`}
                    onClick={() => updateFramingMode(mode)}
                    title={mode === 'rectangle' ? 'Frame the cutting bounds as a rectangle' : 'Follow the exterior cutting contour'}
                  >
                    {mode === 'rectangle' ? 'Rectangle' : 'Contour'}
                  </button>
                ))}
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase text-text-muted">Feed rate ({feedUnitLabel(units)})</span>
                <input
                  className="input-field font-mono"
                  inputMode="decimal"
                  value={framingFeedInput}
                  onChange={event => { setFramingFeedInput(event.currentTarget.value); setFramingError(null) }}
                  title="Framing motion feed rate"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase text-text-muted">Clearance from top ({linearUnitLabel(units)})</span>
                <input
                  className="input-field font-mono"
                  inputMode="decimal"
                  value={framingClearanceInput}
                  onChange={event => { setFramingClearanceInput(event.currentTarget.value); setFramingError(null) }}
                  title="Signed vertical offset from the highest cutting move"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase text-text-muted">Safe travel height ({linearUnitLabel(units)})</span>
                <input
                  className="input-field font-mono"
                  inputMode="decimal"
                  value={framingTravelZInput}
                  onChange={event => { setFramingTravelZInput(event.currentTarget.value); setFramingError(null) }}
                  title="Z height used for rapid positioning before and after framing"
                />
              </label>

              <div className="rounded border border-warning/35 bg-warning/10 px-3 py-2 text-sm leading-relaxed text-warning">
                Check Z zero first. Safe travel height must clear clamps and stock.
              </div>

              {framingError && (
                <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {framingError}
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn btn-ghost justify-center px-4 py-2 text-sm"
                onClick={() => setShowFramingDialog(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-ok-solid justify-center gap-2 px-4 py-2 text-sm font-semibold"
                disabled={!connected || status.state !== 'Idle' || controllerResetPending}
                title={!connected || status.state !== 'Idle' || controllerResetPending ? 'Wait for the controller to be ready before framing' : 'Start framing routine'}
              >
                <Play size={14} />
                Start frame
              </button>
            </div>
          </form>
        </div>
      )}
      {showLocalSenderWarning && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-3 sm:p-6" onClick={() => setShowLocalSenderWarning(false)}>
          <div
            className="w-full max-w-md rounded-lg border border-border bg-surface shadow-2xl animate-in"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2 text-lg font-semibold text-text-primary">
                <AlertTriangle size={19} className="shrink-0 text-warn" />
                Local stream warning
              </div>
              <button
                className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated"
                onClick={() => setShowLocalSenderWarning(false)}
                title="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 px-4 py-4 text-sm text-text-muted">
              <p>
                Local file streaming is experimental. Use it only with a stable connection to the controller.
              </p>
              <p>
                For best results, keep this browser window open and visible while the job is in progress.
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end">
              <button
                className="btn btn-ghost justify-center px-4 py-2 text-sm"
                onClick={() => setShowLocalSenderWarning(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-ok-solid justify-center gap-2 px-4 py-2 text-sm font-semibold"
                onClick={confirmLocalSenderWarning}
              >
                <Play size={14} />
                Start local job
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
