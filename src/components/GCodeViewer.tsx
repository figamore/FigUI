import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { Eye, Axis3D, Maximize2, Crosshair, Navigation, Play, Pause, Square, CloudDrizzle, Waves, PowerOff, Box, Zap, Orbit, Hand, FileText } from 'lucide-react'
import { type GCodeModel, type Segment, resolveRunningSourceLine, buildSourceLineIndex } from '../lib/gcode'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { sendRaw, sendRealtime } from '../lib/ws'
import { GCodeTextPanel } from './GCodeTextPanel'
import type { ControllerSettings, MachineStatus, Units } from '../types'
import { displayToMm, mmToDisplay } from '../lib/units'
import { formatRuntime, useJobRuntimeEstimate } from '../lib/jobRuntime'
import { createRenderer, renderLines, setStaticLineData, type WebGLRenderer, type Camera, type Vector3 } from '../lib/webgl'
import { addSegmentToPath, clamp01, getArcGeometry, normalizeAngle } from '../lib/gcodeBuild'

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
}

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

interface ViewCubeData {
  faces: CubeFaceData[]
  axisVectors: AxisIndicatorVector[]
  axisOrigin: { x: number; y: number }
}

const TAU = Math.PI * 2
const INITIAL_LOCK_TOLERANCE_MM = 0.25
const FOLLOW_TOLERANCE_MM = 0.2
const ENDPOINT_TOLERANCE_MM = 0.2
const SEGMENT_LOOKAHEAD = 12
const LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT = 100_000
const EMPTY_FLOAT32 = new Float32Array(0)
const WHEEL_ZOOM_SENSITIVITY = 0.0012
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
  vertices: Float32Array
  colors: Float32Array
  uploadedRenderer: WebGLRenderer | null
}

interface Static2DPaths {
  model: GCodeModel
  rapidPath: Path2D
  traversePath: Path2D
  cutPath: Path2D
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

function findEntryExitMarkerPoints(segments: Segment[]) {
  let firstCutIndex = -1
  let lastCutIndex = -1

  for (let index = 0; index < segments.length; index++) {
    if (segments[index].moveType === 'feed') {
      firstCutIndex = index
      break
    }
  }

  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments[index].moveType === 'feed') {
      lastCutIndex = index
      break
    }
  }

  if (firstCutIndex < 0 || lastCutIndex < 0) {
    return { entry: null, exit: null }
  }

  const entryRapid = firstCutIndex > 0 && segments[firstCutIndex - 1].moveType === 'rapid'
    ? segments[firstCutIndex - 1]
    : null
  const exitRapid = lastCutIndex < segments.length - 1 && segments[lastCutIndex + 1].moveType === 'rapid'
    ? segments[lastCutIndex + 1]
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

function buildEntryExitMarkerGeometry(segments: Segment[]) {
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

function measureProgressAlongSegment(seg: Segment, px: number, py: number) {
  if (seg.i === undefined) {
    const dx = seg.x1 - seg.x0
    const dy = seg.y1 - seg.y0
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-9) {
      const distSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2
      return { fraction: 0, distanceSq: distSq }
    }
    const rawFraction = ((px - seg.x0) * dx + (py - seg.y0) * dy) / lenSq
    const fraction = clamp01(rawFraction)
    const projX = seg.x0 + dx * fraction
    const projY = seg.y0 + dy * fraction
    const distanceSq = (px - projX) ** 2 + (py - projY) ** 2
    return { fraction, distanceSq }
  }

  const arc = getArcGeometry(seg)
  if (arc.r < 1e-9) {
    const distSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2
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
    const distanceSq = (px - projX) ** 2 + (py - projY) ** 2
    return { fraction, distanceSq }
  }

  const startDistSq = (px - seg.x0) ** 2 + (py - seg.y0) ** 2
  const endDistSq = (px - seg.x1) ** 2 + (py - seg.y1) ** 2
  return startDistSq <= endDistSq
    ? { fraction: 0, distanceSq: startDistSq }
    : { fraction: 1, distanceSq: endDistSq }
}

function compareProgress(a: ToolpathProgress, b: ToolpathProgress) {
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
  return a.fraction - b.fraction
}

function pointDistanceSq(ax: number, ay: number, bx: number, by: number) {
  return (ax - bx) ** 2 + (ay - by) ** 2
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
      snapTheta: orbit.theta, snapPhi: 0.02,
    },
    {
      label: 'Bottom', n: { x: 0, y: 0, z: -1 },
      corners: [{ x: 1, y: -1, z: -1 }, { x: -1, y: -1, z: -1 }, { x: -1, y: 1, z: -1 }, { x: 1, y: 1, z: -1 }],
      snapTheta: orbit.theta, snapPhi: Math.PI - 0.02,
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
    const projectedCorners = def.corners.map(project)
    const projectedCenter = project(def.n)
    const labelXAxis = {
      x: ((projectedCorners[0].x - projectedCorners[1].x) + (projectedCorners[3].x - projectedCorners[2].x)) / 4,
      y: ((projectedCorners[0].y - projectedCorners[1].y) + (projectedCorners[3].y - projectedCorners[2].y)) / 4,
    }
    const labelYAxis = {
      x: ((projectedCorners[2].x - projectedCorners[1].x) + (projectedCorners[3].x - projectedCorners[0].x)) / 4,
      y: ((projectedCorners[2].y - projectedCorners[1].y) + (projectedCorners[3].y - projectedCorners[0].y)) / 4,
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

  const axisOrigin3D = { x: -1, y: -1, z: -1 }
  const axisOrigin = project(axisOrigin3D)
  const axisEdgeDefs: Array<{
    label: 'X' | 'Y' | 'Z'
    color: string
    end: { x: number; y: number; z: number }
  }> = [
    { label: 'X', color: AXIS_X_COLOR, end: { x: 1, y: -1, z: -1 } },
    { label: 'Y', color: AXIS_Y_COLOR, end: { x: -1, y: 1, z: -1 } },
    { label: 'Z', color: AXIS_Z_COLOR, end: { x: -1, y: -1, z: 1 } },
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

  return { faces, axisVectors, axisOrigin }
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
  segments: Segment[],
  px: number,
  py: number,
  startIndex: number,
  endIndex: number,
  toleranceSq: number,
  previous: ToolpathProgress | null,
  preferLatest: boolean,
): ToolpathProgress | null {
  let best: (ToolpathProgress & { distanceSq: number }) | null = null

  for (let i = startIndex; i <= endIndex && i < segments.length; i++) {
    const measurement = measureProgressAlongSegment(segments[i], px, py)
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

function findToolpathProgress(
  segments: Segment[],
  px: number,
  py: number,
  previous: ToolpathProgress | null,
): ToolpathProgress | null {
  if (segments.length === 0) return null

  if (!previous) {
    return findNearbyProgress(
      segments,
      px,
      py,
      0,
      segments.length - 1,
      INITIAL_LOCK_TOLERANCE_MM ** 2,
      null,
      false,
    )
  }

  const candidate = findNearbyProgress(
    segments,
    px,
    py,
    previous.segmentIndex,
    previous.segmentIndex + SEGMENT_LOOKAHEAD,
    FOLLOW_TOLERANCE_MM ** 2,
    previous,
    true,
  )
  if (candidate) return candidate

  const current = segments[previous.segmentIndex]
  if (pointDistanceSq(px, py, current.x1, current.y1) <= ENDPOINT_TOLERANCE_MM ** 2) {
    return { segmentIndex: previous.segmentIndex, fraction: 1 }
  }

  return previous
}

/** Conservative progress for line-number display — advances one segment at a time. */
function findLineToolpathProgress(
  segments: Segment[],
  px: number,
  py: number,
  previous: ToolpathProgress | null,
): ToolpathProgress | null {
  if (segments.length === 0) return null
  if (!previous) return { segmentIndex: 0, fraction: 0 }

  const toleranceSq = FOLLOW_TOLERANCE_MM ** 2
  const current = segments[previous.segmentIndex]
  const onCurrent = measureProgressAlongSegment(current, px, py)
  if (onCurrent.distanceSq <= toleranceSq) {
    return {
      segmentIndex: previous.segmentIndex,
      fraction: Math.max(previous.fraction, onCurrent.fraction),
    }
  }

  const nextIndex = previous.segmentIndex + 1
  if (nextIndex < segments.length) {
    const onNext = measureProgressAlongSegment(segments[nextIndex], px, py)
    if (onNext.distanceSq <= toleranceSq) {
      return { segmentIndex: nextIndex, fraction: onNext.fraction }
    }
  }

  if (previous.fraction >= 0.999) {
    const endDistSq = pointDistanceSq(px, py, current.x1, current.y1)
    if (endDistSq <= ENDPOINT_TOLERANCE_MM ** 2 && nextIndex < segments.length) {
      return { segmentIndex: nextIndex, fraction: 0 }
    }
  }

  return previous
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

export function GCodeViewer({ className, isTablet, showOverrides }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const model = useGCodeStore(s => s.model)
  const sourceText = useGCodeStore(s => s.sourceText)
  const fetchSourceText = useGCodeStore(s => s.fetchSourceText)
  const fileName = useGCodeStore(s => s.fileName)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const loading = useGCodeStore(s => s.loading)
  const pendingPath = useGCodeStore(s => s.pendingPath)
  const downloadProgress = useGCodeStore(s => s.downloadProgress)
  const isProcessing2D = useGCodeStore(s => s.isProcessing2D)
  const processing2DProgress = useGCodeStore(s => s.processing2DProgress)
  const isProcessing3D = useGCodeStore(s => s.isProcessing3D)
  const processing3DProgress = useGCodeStore(s => s.processing3DProgress)
  const is3DReady = useGCodeStore(s => s.is3DReady)
  const showRapids = useGCodeStore(s => s.showRapids)
  const setShowRapids = useGCodeStore(s => s.setShowRapids)
  const storePaths2D = useGCodeStore(s => s.paths2D)
  const storeGeometry3D = useGCodeStore(s => s.geometry3D)
  const modelRef = useRef<GCodeModel | null>(null)
  const staticPathGeometryRef = useRef<StaticPathGeometry | null>(null)
  const static2DPathsRef = useRef<Static2DPaths | null>(null)
  const markerGeometryRef = useRef<MarkerGeometry | null>(null)
  const [showTool, setShowTool] = useState(true)
  const showRapidsRef = useRef(true)
  const showToolRef = useRef(true)
  const transformRef = useRef<Transform>({ ox: 0, oy: 0, scale: 1 })
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const activePointersRef = useRef<Map<number, { x: number; y: number; dragMode: DragMode }>>(new Map())
  const lastPinchDistRef = useRef<number | null>(null)
  const animRef = useRef(0)
  const renderRef = useRef<() => void>(() => {})
  const needsFitRef = useRef(true)
  const progressRef = useRef<ToolpathProgress | null>(null)
  const lineProgressRef = useRef<ToolpathProgress | null>(null)
  const prevIsRunningRef = useRef(false)
  const prevModelRef = useRef<GCodeModel | null>(null)

  const [is3D, setIs3D] = useState(false)
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('orthographic')
  const [dragMode, setDragMode] = useState<DragMode>('orbit')
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
  const orbitDragRef = useRef<{ sx: number; sy: number; theta: number; phi: number } | null>(null)
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
    camera.target.x = orbit.target.x
    camera.target.y = orbit.target.y
    camera.target.z = orbit.target.z
    camera.position.x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta)
    camera.position.y = orbit.target.y + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta)
    camera.position.z = orbit.target.z + orbit.radius * Math.cos(orbit.phi)
    camera.projection = projectionMode
    camera.orthoSize = Math.max(orbit.orthoSize, 1e-3)
    updateCameraClipping(orbit)
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
      sx: clientX,
      sy: clientY,
      theta: orbitState.theta,
      phi: orbitState.phi,
    }
    panDragRef.current = null
  }

  function createVertexData(
    segments: Segment[],
    progress: ToolpathProgress | null,
    toolWpos: { x: number; y: number; z: number } | null,
  ) {
    const vertices: number[] = []
    const colors: number[] = []
    const triangleVertices: number[] = []
    const triangleColors: number[] = []

    const RAPID_C     = [0.4,  0.5,  0.7,  1.0] as const
    const TRAVERSE_C  = [0.35, 0.6,  0.35, 0.7] as const
    const CUT_C       = [0.94, 0.63, 0.19, 1.0] as const
    const DONE_C      = [0.13, 0.77, 0.37, 1.0] as const
    const TOOL_C      = [0.94, 0.27, 0.27, 1.0] as const
    const TOOL_GLOW_C = [1.0,  0.27, 0.27, 0.55] as const
    const TOOL_CAP_C  = [1.0,  0.35, 0.35, 0.38] as const
    const TOOL_TIP_C  = [1.0,  0.96, 0.96, 1.0] as const

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const seg = segments[segIdx]
      if (seg.moveType !== 'feed' && !showRapidsRef.current) continue

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
          colors.push(...(subDone ? DONE_C : CUT_C), ...(subDone ? DONE_C : CUT_C))
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
          colors.push(...CUT_C, ...CUT_C)
        } else {
          const c = isCurrent && frac >= 1 ? DONE_C : CUT_C
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
    const cached = staticPathGeometryRef.current
    if (!cached || cached.model !== mdl || cached.showRapids !== showRapidsRef.current) return null

    if (rendererRef.current && cached.uploadedRenderer !== rendererRef.current) {
      setStaticLineData(rendererRef.current, cached.vertices, cached.colors)
      cached.uploadedRenderer = rendererRef.current
    }

    return cached
  }

  function clearStaticPathGeometryUpload() {
    if (rendererRef.current) {
      setStaticLineData(rendererRef.current, EMPTY_FLOAT32, EMPTY_FLOAT32)
    }
    if (staticPathGeometryRef.current) {
      staticPathGeometryRef.current.uploadedRenderer = null
    }
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

    const rapidPath = new Path2D()
    const traversePath = new Path2D()
    const cutPath = new Path2D()
    for (const seg of mdl.segments) {
      const path = seg.moveType === 'rapid' ? rapidPath : seg.moveType === 'traverse' ? traversePath : cutPath
      addSegmentToPath(path, seg)
    }

    const paths = { model: mdl, rapidPath, traversePath, cutPath }
    static2DPathsRef.current = paths
    return paths
  }

  const status = useMachineStore(s => s.status)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const units = useMachineStore(s => s.units)
  const runtime = useJobRuntimeEstimate(status, model, controllerSettings, loadedPath, fileName)
  const progressPercent = runtime.progressPercent
  const showEstimatedTiming = runtime.source === 'estimated'
  const isRunning = status.state === 'Run' || status.state === 'Hold'
  const isJobRunning = status.state === 'Run'
  const isJobHeld = status.state === 'Hold'
  const isLargeProgressOverlayDisabled = !!model && isRunning && model.segments.length > LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT
  const cancelAndStartJob = useGCodeStore(s => s.cancelAndStartJob)
  const cancelLoad = useGCodeStore(s => s.clear)
  const handleStartWithoutPreview = useCallback(() => {
    const path = pendingPath
    if (!path) return
    cancelAndStartJob(path)
  }, [pendingPath, cancelAndStartJob])

  const isViewerStartBlocked = loading || isProcessing2D || pendingPath !== null
  const is3DToggleDisabled = pendingPath !== null || isProcessing2D || (!!model && !is3DReady)
  const [autoFollow, setAutoFollow] = useState(true)
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [sourceTextLoading, setSourceTextLoading] = useState(false)
  const [coolantState, setCoolantState] = useState<'off' | 'mist' | 'flood'>('off')
  const [currentSourceLine, setCurrentSourceLine] = useState<number | null>(null)
  const sourceTextIndex = useMemo(
    () => (sourceText ? buildSourceLineIndex(sourceText) : null),
    [sourceText],
  )

  // Keep refs in sync so render() (called from non-React contexts) reads current values
  showRapidsRef.current = showRapids
  showToolRef.current = showTool

  useEffect(() => {
    modelRef.current = model
    static2DPathsRef.current = (storePaths2D && model)
      ? { model, rapidPath: storePaths2D.rapidPath, traversePath: storePaths2D.traversePath, cutPath: storePaths2D.cutPath }
      : null
    staticPathGeometryRef.current = (storeGeometry3D && model)
      ? {
          model,
          showRapids: storeGeometry3D.showRapids,
          vertices: storeGeometry3D.vertices,
          colors: storeGeometry3D.colors,
          uploadedRenderer: null,
        }
      : null
    markerGeometryRef.current = null
    progressRef.current = null
    lineProgressRef.current = null
    if (model && model !== prevModelRef.current) {
      needsFitRef.current = true
      if (is3D && !storeGeometry3D) {
        setIs3D(false)
      }
    }
    scheduleRender()
  }, [model, storePaths2D, storeGeometry3D, is3D])

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
      const { w, h } = canvasLogicalSize()
      const clipBounds = getClipBounds(mdl ? mdl.bounds : null)
      const centerX = (clipBounds.minX + clipBounds.maxX) / 2
      const centerY = (clipBounds.minY + clipBounds.maxY) / 2
      const centerZ = (clipBounds.minZ + clipBounds.maxZ) / 2
      const camera = cameraRef.current
      const aspect = Math.max(w / Math.max(h, 1), 1e-6)
      const tanHalfFov = Math.max(Math.tan(camera.fov / 2), 1e-6)
      const target = { x: centerX, y: centerY, z: centerZ }
      const fitOrbit = { ...orbitState, target }
      const { forward, right, screenUp } = getOrbitCameraBasis(fitOrbit, camera.up)
      const corners = getBoundsCorners(clipBounds)
      let nextRadius = 1
      let nextOrthoSize = orbitState.orthoSize

      if (projectionMode === 'orthographic') {
        let maxRight = 0
        let maxUp = 0
        let maxTargetDistance = 0
        const diagonal = Math.hypot(
          clipBounds.maxX - clipBounds.minX,
          clipBounds.maxY - clipBounds.minY,
          clipBounds.maxZ - clipBounds.minZ,
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
    cancelAnimationFrame(animRef.current)
    animRef.current = requestAnimationFrame(() => renderRef.current())
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

      const running3d = store.status.state === 'Run' || store.status.state === 'Hold'
      const progress3d = running3d ? progressRef.current : null
      const use3DProgressOverlay = mdl !== null && progress3d !== null && mdl.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT
      const wpos3d = showToolRef.current ? store.status.wpos : null
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
          ? createVertexData([], null, wpos3d)
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
          ? createVertexData([], null, wpos3d)
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
      const running = store.status.state === 'Run' || store.status.state === 'Hold'

      if (!mdl) {
        if (showToolRef.current) {
          const wpos = store.status.wpos
          drawToolPosition(ctx, t, wpos.x, wpos.y, running)
        }
        return
      }

      const { segments } = mdl
      const progress = running ? progressRef.current : null

      const staticPaths = ensureStatic2DPaths(mdl)

      strokeModelPath(ctx, staticPaths.cutPath, t, CUT_COLOR_FG, 1)
      if (showRapidsRef.current) {
        strokeModelPath(ctx, staticPaths.traversePath, t, TRAVERSE_COLOR, 0.5, [2, 2])
        strokeModelPath(ctx, staticPaths.rapidPath, t, RAPID_COLOR, 0.5, [4, 3])
      }

      const use2DProgressOverlay = progress !== null && mdl.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT

      if (use2DProgressOverlay) {
        ctx.strokeStyle = CUT_DONE
        ctx.lineWidth = 1.5
        ctx.setLineDash([])

        for (let i = 0; i <= progress.segmentIndex; i++) {
          const seg = segments[i]
          if (seg.moveType !== 'feed') continue
          drawSegment(ctx, seg, t, i === progress.segmentIndex ? progress.fraction : 1)
        }
      }
      ctx.setLineDash([])

      if (showToolRef.current) {
        const wpos = store.status.wpos
        drawToolPosition(ctx, t, wpos.x, wpos.y, running)
      }
    }
  }
  renderRef.current = render

  function ensureToolVisible(wx: number, wy: number) {
    const { w, h } = canvasLogicalSize()
    const t = transformRef.current
    const sx = t.ox + wx * t.scale
    const sy = t.oy - wy * t.scale
    const margin = 40
    let dx = 0, dy = 0
    if (sx < margin) dx = margin - sx
    else if (sx > w - margin) dx = (w - margin) - sx
    if (sy < margin) dy = margin - sy
    else if (sy > h - margin) dy = (h - margin) - sy
    if (dx !== 0 || dy !== 0) {
      t.ox += dx
      t.oy += dy
    }
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
    if (isRunning && modelRef.current) {
      const progressOverlayEnabled = modelRef.current.segments.length <= LARGE_PROGRESS_OVERLAY_SEGMENT_LIMIT
      const freshStart = !prevIsRunningRef.current || model !== prevModelRef.current

      if (freshStart) {
        progressRef.current = { segmentIndex: 0, fraction: 0 }
        lineProgressRef.current = { segmentIndex: 0, fraction: 0 }
      } else {
        lineProgressRef.current = findLineToolpathProgress(
          modelRef.current.segments,
          status.wpos.x,
          status.wpos.y,
          lineProgressRef.current,
        )
        if (progressOverlayEnabled) {
          progressRef.current = findToolpathProgress(
            modelRef.current.segments,
            status.wpos.x,
            status.wpos.y,
            progressRef.current,
          )
        } else {
          progressRef.current = null
        }
      }
    } else {
      progressRef.current = null
      lineProgressRef.current = null
    }

    if (isRunning && (modelRef.current || sourceText)) {
      const mdl = modelRef.current
      const idx = mdl
        ? {
            sourceLineCount: mdl.sourceLineCount,
            lineByteOffsets: mdl.lineByteOffsets,
            sourceByteLength: mdl.sourceByteLength,
            lineNumberToSourceLine: mdl.lineNumberToSourceLine,
          }
        : sourceTextIndex

      const lineProgress = lineProgressRef.current
      setCurrentSourceLine(resolveRunningSourceLine({
        sourceLineCount: idx?.sourceLineCount ?? 0,
        lineByteOffsets: idx?.lineByteOffsets,
        sourceByteLength: idx?.sourceByteLength,
        lineNumberToSourceLine: idx?.lineNumberToSourceLine,
        segments: mdl?.segments,
        segmentIndex: lineProgress?.segmentIndex ?? null,
        segmentFraction: lineProgress?.fraction ?? 0,
        executingLineNumber: status.lineNumber,
        // SD percent is bytes read into the parser buffer — only use when no toolpath model.
        sdPercent: mdl ? undefined : status.sdPercent,
      }))
    } else {
      setCurrentSourceLine(null)
    }
    prevIsRunningRef.current = isRunning
    prevModelRef.current = model

    if (isRunning && autoFollow && showTool) {
      ensureToolVisible(status.wpos.x, status.wpos.y)
    }
    scheduleRender()
  }, [
    model,
    showRapids,
    showTool,
    isRunning,
    autoFollow,
    status.wpos.x,
    status.wpos.y,
    status.wpos.z,
    status.wco.x,
    status.wco.y,
    status.sdPercent,
    status.lineNumber,
    sourceText,
    sourceTextIndex,
    controllerSettings.maxTravelX,
    controllerSettings.maxTravelY,
    controllerSettings.homingDirInvert,
    controllerSettings.machineMinX,
    controllerSettings.machineMaxX,
    controllerSettings.machineMinY,
    controllerSettings.machineMaxY,
    units,
    is3D,
  ])

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
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const pointerDragMode = is3D && e.button === 2 ? 'pan' : dragMode
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
      if (lastPinchDistRef.current !== null) {
        const factor = dist / lastPinchDistRef.current

        if (is3D) {
          const smoothFactor = 1 + (factor - 1) * 0.5
          const anchor = getScreenAnchor((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
          setOrbitState(prev => zoomOrbitTowardAnchor(prev, 1 / smoothFactor, anchor))
        } else {
          const t = transformRef.current
          const rect = containerRef.current!.getBoundingClientRect()
          const mx = (p1.x + p2.x) / 2 - rect.left
          const my = (p1.y + p2.y) / 2 - rect.top
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
        const sensitivity = 0.01
        const newTheta = d.theta - (e.clientX - d.sx) * sensitivity
        const newPhi = Math.max(0.1, Math.min(Math.PI - 0.1, d.phi - (e.clientY - d.sy) * sensitivity))

        setOrbitState(prev => ({
          ...prev,
          theta: newTheta,
          phi: newPhi
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

  useEffect(() => {
    if (!showCodePanel || sourceText || !loadedPath) return
    let cancelled = false
    setSourceTextLoading(true)
    fetchSourceText()
      .finally(() => { if (!cancelled) setSourceTextLoading(false) })
    return () => { cancelled = true }
  }, [showCodePanel, sourceText, loadedPath, fetchSourceText])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      loadFromText(reader.result as string, file.name)
      needsFitRef.current = true
    }
    reader.readAsText(file)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  const VCX = 45, VCY = 45, CUBE_S = 16
  const viewCubeData = is3D ? get3DViewCubeData(orbitState, cameraRef.current.up, VCX, VCY, CUBE_S) : null

  return (
    <div className={`panel flex flex-col overflow-hidden ${className ?? ''}`}>
      <div className="panel-header !flex-col !items-stretch sm:!flex-row sm:!items-center sm:justify-between gap-y-1.5">
        {!isTablet && (
        <div className="flex items-center gap-2 min-w-0">
          {fileName ? (
            <span className="text-text-primary font-mono normal-case tracking-normal font-normal truncate text-sm">
              {fileName}
            </span>
          ) : (
            <span className="text-text-dim text-sm whitespace-nowrap">No file loaded</span>
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
        <div className="flex items-center gap-1 flex-wrap justify-start sm:justify-end ml-auto">
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
                  ? 'Drag to orbit. Right-drag to pan.'
                  : 'Drag to pan. Right-drag also pans.'}
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
              onClick={() => setAutoFollow(v => !v)}
              title="Pan canvas to keep tool in view while running"
            >
              <Navigation size={iconSize} />
              <span>Follow</span>
            </button>
          )}
          <button
            className={`${btnCls} ${showCodePanel ? 'text-info bg-info/10' : 'text-text-dim bg-elevated hover:text-text-primary'} ${!fileName && !loadedPath ? 'opacity-50 cursor-not-allowed hover:text-text-dim hover:bg-elevated' : ''}`}
            onClick={() => {
              if (!fileName && !loadedPath) return
              setShowCodePanel(v => !v)
            }}
            title="Show G-code source text"
            disabled={!fileName && !loadedPath}
          >
            <FileText size={iconSize} />
            <span>Code</span>
          </button>
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

      <div className={`flex flex-1 min-h-0 ${showCodePanel ? 'flex-col lg:flex-row' : ''}`}>
      <div
        ref={containerRef}
        className={`${showCodePanel ? 'flex-1 min-h-[180px] lg:min-h-0 lg:min-w-0' : 'flex-1 min-h-0'} relative cursor-grab active:cursor-grabbing`}
        style={{ touchAction: 'none' }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onContextMenu={e => { if (is3D) e.preventDefault() }}
      >
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 ${is3D ? 'hidden' : ''} ${loading ? 'blur-[2px] opacity-40' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <canvas
          ref={webglCanvasRef}
          className={`absolute inset-0 ${!is3D ? 'hidden' : ''} ${loading ? 'blur-[2px] opacity-40' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/70 backdrop-blur-sm px-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-surface/95 shadow-lg p-4 space-y-3">
              <div className="text-base text-text-primary font-mono truncate">
                {pendingPath?.split('/').pop() ?? fileName ?? 'Loading file'}
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-base text-text-dim uppercase tracking-wide">
                  <span>Download From SD</span>
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
                <button
                  className="btn btn-warn gap-2 justify-center text-sm flex-1"
                  onClick={handleStartWithoutPreview}
                  title="Cancel the preview download and start the job immediately"
                >
                  <Zap size={12} />
                  Start without preview
                </button>
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
            width="90"
            height="90"
            viewBox="0 0 90 90"
            style={{ overflow: 'visible' }}
            aria-hidden="true"
          >
            {viewCubeData?.faces.map(face => {
              const points = face.projectedCorners.map(p => `${p.x},${p.y}`).join(' ')
              const visF = (-face.depth + 1) / 2
              const fillAlpha = 0.38 + visF * 0.38
              return (
                <g key={face.label}>
                  <polygon
                    points={points}
                    fill={`rgba(170, 176, 186, ${fillAlpha})`}
                    stroke="rgba(92, 98, 108, 0.72)"
                    strokeWidth="0.9"
                    strokeLinejoin="round"
                    style={{ cursor: face.isVisible ? 'pointer' : 'default', pointerEvents: face.isVisible ? 'auto' : 'none' }}
                    onClick={face.isVisible ? () => snapOrbitToView(face.snapTheta, face.snapPhi) : undefined}
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

      {showCodePanel && (
        <GCodeTextPanel
          text={sourceText}
          loading={sourceTextLoading}
          activeLine={currentSourceLine}
          followActiveLine={isJobRunning || isJobHeld}
          className={`${isTablet ? 'h-[38vh]' : 'h-[34vh]'} lg:h-auto lg:w-[min(420px,38%)] border-t lg:border-t-0 lg:border-l border-border shrink-0`}
        />
      )}
      </div>

      {/* Permanent bottom strip */}
      <div className="shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3 flex flex-col gap-2">
        {/* Progress bar — only while a job is active */}
        {(isJobRunning || isJobHeld) && (
          <div className="flex flex-col gap-1.5">
            {currentSourceLine != null && (
              <div className="text-[11px] font-mono text-text-muted tabular-nums">
                Line {currentSourceLine}{model?.sourceLineCount ? ` / ${model.sourceLineCount}` : ''}
              </div>
            )}
            {progressPercent != null && (
              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-ok transition-all duration-500 rounded-full" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}
            {showEstimatedTiming && (
              <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-text-muted tabular-nums">
                <span>Elapsed {formatRuntime(runtime.elapsedSeconds)}</span>
                <span>Remain {formatRuntime(runtime.remainingSeconds)}</span>
                <span>Total {formatRuntime(runtime.totalSeconds)}</span>
              </div>
            )}
          </div>
        )}

        {showOverrides && (
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

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        {(controllerSettings.hasMist || controllerSettings.hasFlood) && <>
          <div className="flex gap-1.5 sm:flex-[6]">
            {controllerSettings.hasMist && <button
              onClick={() => { sendRealtime(0xA0); setCoolantState('mist') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'mist' ? 'border-accent/50 text-accent' : 'btn-ghost'}`}
            >
              <CloudDrizzle size={isTablet ? 18 : 13} />
              Mist
            </button>}
            {controllerSettings.hasFlood && <button
              onClick={() => { sendRealtime(0xA1); setCoolantState('flood') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'flood' ? 'border-info/50 text-info' : 'btn-ghost'}`}
            >
              <Waves size={isTablet ? 18 : 13} />
              Flood
            </button>}
            <button
              onClick={() => { sendRaw('M9'); setCoolantState('off') }}
              className={`btn gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-lg'} justify-center flex-1 ${coolantState === 'off' ? 'border-danger/50 text-danger' : 'btn-ghost'}`}
            >
              <PowerOff size={isTablet ? 18 : 13} />
              Off
            </button>
          </div>
          <div className="hidden sm:block w-px bg-border self-stretch" />
        </>}

        <div className={`flex gap-1.5 ${(controllerSettings.hasMist || controllerSettings.hasFlood) ? 'sm:flex-[3]' : 'sm:ml-auto'}`}>
          {!isJobRunning && !isJobHeld && (
            <button
              className={`btn btn-ok-solid gap-2 justify-center font-bold ${isTablet ? 'text-xl py-3' : 'text-base'} flex-1`}
              onClick={() => loadedPath && sendRaw(`$SD/Run=${loadedPath}`)}
              disabled={!loadedPath || isViewerStartBlocked}
              title={isViewerStartBlocked ? 'Wait for the file download and 2D processing to finish before starting the job' : 'Start job from loaded SD file'}
            >
              <Play size={isTablet ? 18 : 14} />
              Start
            </button>
          )}
          {isJobRunning && (
            <button className={`btn btn-warn-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`} onClick={() => sendRealtime(0x21)}>
              <Pause size={isTablet ? 18 : 13} />
              Pause
            </button>
          )}
          {isJobHeld && (
            <button className={`btn btn-ok-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`} onClick={() => sendRealtime(0x7e)}>
              <Play size={isTablet ? 18 : 13} />
              Resume
            </button>
          )}
          {(isJobRunning || isJobHeld) && (
            <button className={`btn btn-danger-solid gap-1.5 ${isTablet ? 'text-xl py-3' : 'text-sm'} justify-center flex-1`} onClick={() => sendRealtime(0x18)}>
              <Square size={isTablet ? 18 : 13} />
              Abort
            </button>
          )}
        </div>
        </div>
        {isTablet && (
          <div className="flex items-center gap-2 min-w-0 pt-1 border-t border-border">
            {fileName ? (
              <span className="text-text-primary font-mono normal-case tracking-normal font-normal truncate text-base">
                {fileName}
              </span>
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
    </div>
  )
}
