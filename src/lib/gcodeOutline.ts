import { MOVE_FEED, type GCodeModel, type Segment, type SegmentTable } from './gcode'
import { getArcGeometry } from './gcodeBuild'
import { linearUnitLabel, mmToDisplay } from './units'
import type { Units } from '../types'

export type FramingMode = 'rectangle' | 'contour'

export interface FramingOptions {
  mode: FramingMode
  feedMmPerMin: number
  clearanceMm: number
  travelZMm: number
  displayUnits?: Units
}

interface Point {
  x: number
  y: number
}

interface CutEnvelope {
  minX: number
  minY: number
  maxX: number
  maxY: number
  topZ: number
  points: Point[]
  closedContours: Point[][]
}

const ARC_SAMPLE_TARGET_MM = 1.5
const ARC_SAMPLE_MAX = 96
const POINT_KEY_SCALE = 1000
const CONNECT_TOLERANCE_MM = 0.001
const XY_MOVE_TOLERANCE_MM = 0.001
const Z_ZERO_TOLERANCE_MM = 0.001
const TOP_ZERO_CUT_DEPTH_MM = 0.05
const TOP_ZERO_LEADOUT_MAX_Z_MM = 2
const TOP_ZERO_LEADOUT_MAX_LENGTH_MM = 2
const TOP_ZERO_LEADOUT_MAX_LENGTH_FRACTION = 0.01
const Z_APPROACH_FEED_MAX_MM_PER_MIN = 200

export function buildFramingGCode(model: GCodeModel, options: FramingOptions): string | null {
  const envelope = getCutEnvelope(model.segments)
  if (!envelope) return null

  const path = options.mode === 'rectangle'
    ? rectanglePath(envelope)
    : exteriorContour(envelope) ?? convexHull(envelope.points)

  if (path.length < 2) return null

  const frameZ = envelope.topZ + options.clearanceMm
  if (!Number.isFinite(options.travelZMm)) throw new Error('Safe travel height must be valid.')
  if (options.travelZMm < frameZ) {
    const units = options.displayUnits ?? 'mm'
    const unit = linearUnitLabel(units)
    const shown = (mm: number) => format(mmToDisplay(mm, units), units === 'in' ? 4 : 3)
    const detail = Math.abs(envelope.topZ) <= Z_ZERO_TOLERANCE_MM
      ? `Safe travel height must be at least the ${shown(options.clearanceMm)} ${unit} clearance from top.`
      : `Required height is estimated stock top Z${shown(envelope.topZ)} ${unit} plus ${shown(options.clearanceMm)} ${unit} clearance from top.`
    throw new Error(
      `Safe travel height must be at least ${shown(frameZ)} ${unit}. `
      + detail,
    )
  }
  const feed = Math.max(1, options.feedMmPerMin)
  const zApproachFeed = Math.min(feed, Z_APPROACH_FEED_MAX_MM_PER_MIN)
  const closedPath = closePath(path)
  const lines = [
    '(FigUI framing routine)',
    `(${options.mode === 'rectangle' ? 'Rectangle' : 'Contour'} outline from cutting moves only)`,
    'G21 G90 G94',
    `G0 Z${format(options.travelZMm, 3)}`,
    `G0 X${format(closedPath[0].x, 3)} Y${format(closedPath[0].y, 3)}`,
    `G1 F${format(zApproachFeed, 1)}`,
    `G1 Z${format(frameZ, 3)}`,
    `G1 F${format(feed, 1)}`,
    ...closedPath.slice(1).map(point => `G1 X${format(point.x, 3)} Y${format(point.y, 3)}`),
    `G0 Z${format(options.travelZMm, 3)}`,
    'M2',
  ]
  return lines.join('\n')
}

export function getFramingRequiredTravelZ(model: GCodeModel, clearanceMm: number): number | null {
  if (!Number.isFinite(clearanceMm)) return null
  const envelope = getCutEnvelope(model.segments)
  return envelope ? envelope.topZ + clearanceMm : null
}

function getCutEnvelope(segments: SegmentTable): CutEnvelope | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let minCuttingZ = Infinity
  let maxCuttingZ = -Infinity
  let totalCuttingXYLength = 0
  let positiveCuttingXYLength = 0
  const points: Point[] = []
  const closedContours: Point[][] = []
  const seen = new Set<string>()
  let activeContour: Point[] = []

  function addPoint(x: number, y: number) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    const key = `${Math.round(x * POINT_KEY_SCALE)},${Math.round(y * POINT_KEY_SCALE)}`
    if (!seen.has(key)) {
      seen.add(key)
      points.push({ x, y })
    }
  }

  function captureClosedSuffix() {
    if (activeContour.length < 4) return
    const last = activeContour[activeContour.length - 1]
    // CAM lead-ins mean a real profile often closes at a point in the middle
    // of a continuous feed chain rather than at the chain's first point.
    // Recover that embedded cycle and leave any following lead-out separate.
    for (let index = activeContour.length - 2; index >= 0; index--) {
      if (!pointsEqual(activeContour[index], last)) continue
      const contour = activeContour.slice(index, -1)
      if (contour.length >= 3 && Math.abs(signedArea(contour)) > CONNECT_TOLERANCE_MM ** 2) {
        closedContours.push(contour)
        activeContour = [{ ...last }]
      }
      return
    }
  }

  for (let index = 0; index < segments.length; index++) {
    if (segments.moveCode(index) !== MOVE_FEED) {
      activeContour = []
      continue
    }
    const seg = segments.get(index)
    if (!isXYCuttingMove(seg)) {
      activeContour = []
      continue
    }

    const length = xyMoveLength(seg)
    minCuttingZ = Math.min(minCuttingZ, seg.z0, seg.z1)
    maxCuttingZ = Math.max(maxCuttingZ, seg.z0, seg.z1)
    totalCuttingXYLength += length
    positiveCuttingXYLength += positiveZLength(seg, length)
    const segmentPoints: Point[] = [{ x: seg.x0, y: seg.y0 }]
    if (seg.i !== undefined) {
      const arc = getArcGeometry(seg)
      const samples = Math.max(8, Math.min(ARC_SAMPLE_MAX, Math.ceil((arc.sweep * arc.r) / ARC_SAMPLE_TARGET_MM)))
      for (let index = 1; index < samples; index++) {
        const fraction = index / samples
        const angle = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * fraction
        segmentPoints.push({
          x: arc.cx + Math.cos(angle) * arc.r,
          y: arc.cy + Math.sin(angle) * arc.r,
        })
      }
    }
    segmentPoints.push({ x: seg.x1, y: seg.y1 })

    if (activeContour.length > 0 && !pointsEqual(activeContour[activeContour.length - 1], segmentPoints[0])) {
      activeContour = []
    }
    for (const point of segmentPoints) {
      addPoint(point.x, point.y)
      if (activeContour.length === 0 || !pointsEqual(activeContour[activeContour.length - 1], point)) {
        activeContour.push({ x: point.x, y: point.y })
      }
    }
    captureClosedSuffix()
  }
  if (!Number.isFinite(minX) || points.length === 0) return null
  const topZ = estimateJobTopZ({ minCuttingZ, maxCuttingZ, totalCuttingXYLength, positiveCuttingXYLength })
  return { minX, minY, maxX, maxY, topZ, points, closedContours }
}

function isXYCuttingMove(seg: Segment) {
  if (seg.i !== undefined) return true
  return (seg.x1 - seg.x0) ** 2 + (seg.y1 - seg.y0) ** 2 > XY_MOVE_TOLERANCE_MM ** 2
}

function xyMoveLength(seg: Segment) {
  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    return arc.sweep * arc.r
  }
  return Math.sqrt((seg.x1 - seg.x0) ** 2 + (seg.y1 - seg.y0) ** 2)
}

function positiveZLength(seg: Segment, length: number) {
  if (length <= 0) return 0
  if (seg.z0 > Z_ZERO_TOLERANCE_MM && seg.z1 > Z_ZERO_TOLERANCE_MM) return length
  if (seg.z0 <= Z_ZERO_TOLERANCE_MM && seg.z1 <= Z_ZERO_TOLERANCE_MM) return 0
  const dz = seg.z1 - seg.z0
  if (Math.abs(dz) <= Z_ZERO_TOLERANCE_MM) return seg.z0 > Z_ZERO_TOLERANCE_MM ? length : 0
  const zeroCrossing = (Z_ZERO_TOLERANCE_MM - seg.z0) / dz
  return seg.z0 > Z_ZERO_TOLERANCE_MM
    ? length * clamp01(zeroCrossing)
    : length * (1 - clamp01(zeroCrossing))
}

function estimateJobTopZ(stats: {
  minCuttingZ: number
  maxCuttingZ: number
  totalCuttingXYLength: number
  positiveCuttingXYLength: number
}) {
  if (!Number.isFinite(stats.maxCuttingZ)) return 0

  // Top-zero CAM often ramps a short lead-out slightly above Z0; do not let
  // that redefine the stock top, but preserve genuinely positive-Z programs.
  const shortPositiveLeadout = stats.minCuttingZ < -TOP_ZERO_CUT_DEPTH_MM
    && stats.maxCuttingZ > Z_ZERO_TOLERANCE_MM
    && stats.maxCuttingZ <= TOP_ZERO_LEADOUT_MAX_Z_MM
    && stats.positiveCuttingXYLength <= Math.max(
      TOP_ZERO_LEADOUT_MAX_LENGTH_MM,
      stats.totalCuttingXYLength * TOP_ZERO_LEADOUT_MAX_LENGTH_FRACTION,
    )
  return shortPositiveLeadout ? 0 : stats.maxCuttingZ
}

function rectanglePath(bounds: Pick<CutEnvelope, 'minX' | 'minY' | 'maxX' | 'maxY'>): Point[] {
  if (Math.abs(bounds.maxX - bounds.minX) < 1e-6 && Math.abs(bounds.maxY - bounds.minY) < 1e-6) {
    return [{ x: bounds.minX, y: bounds.minY }]
  }
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ]
}

/**
 * Prefer the smallest closed cutting contour that encloses every cutting
 * point. Unlike a convex hull, this preserves concave exterior edges. If the
 * file has no single enclosing closed contour (for example, separate parts or
 * an open toolpath), the caller falls back to the conservative convex hull.
 */
function exteriorContour(envelope: Pick<CutEnvelope, 'points' | 'closedContours'>): Point[] | null {
  let result: Point[] | null = null
  let resultArea = Infinity
  for (const contour of envelope.closedContours) {
    const area = Math.abs(signedArea(contour))
    if (area < resultArea && envelope.points.every(point => pointInOrOnPolygon(point, contour))) {
      result = contour
      resultArea = area
    }
  }
  return result
}

function signedArea(points: Point[]) {
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]
    area += points[index].x * next.y - next.x * points[index].y
  }
  return area / 2
}

function pointInOrOnPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous]
    const b = polygon[index]
    if (Math.abs(cross(a, b, point)) <= CONNECT_TOLERANCE_MM
      && point.x >= Math.min(a.x, b.x) - CONNECT_TOLERANCE_MM
      && point.x <= Math.max(a.x, b.x) + CONNECT_TOLERANCE_MM
      && point.y >= Math.min(a.y, b.y) - CONNECT_TOLERANCE_MM
      && point.y <= Math.max(a.y, b.y) + CONNECT_TOLERANCE_MM) return true
    if ((a.y > point.y) !== (b.y > point.y)) {
      const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < crossingX) inside = !inside
    }
  }
  return inside
}

function pointsEqual(a: Point, b: Point) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= CONNECT_TOLERANCE_MM ** 2
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x)
  if (sorted.length <= 1) return sorted

  const lower: Point[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop()
    }
    lower.push(point)
  }

  const upper: Point[] = []
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop()
    }
    upper.push(point)
  }

  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function cross(origin: Point, a: Point, b: Point) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function closePath(path: Point[]) {
  if (path.length === 0) return path
  const first = path[0]
  const last = path[path.length - 1]
  if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) return path
  return [...path, first]
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

const format = (value: number, digits: number) => String(+value.toFixed(digits))
