import {
  MOVE_FEED,
  MOVE_RAPID,
  MOVE_TRAVERSE,
  NO_TOOL,
  yieldToEventLoop,
  type Segment,
  type SegmentTable,
} from './gcode'

const TAU = Math.PI * 2
export const EMPTY_FLOAT32 = new Float32Array(0)
export const EMPTY_UINT8 = new Uint8Array(0)

const BUILD_SLICE_MS = 12
/** Moves between deadline checks while building geometry in time slices. */
const DEADLINE_CHECK_SEGMENTS = 4096
/** sin² of the largest angle at which consecutive straight moves are drawn as one line. */
const COLLINEAR_SIN_SQ = 1e-12

const TOOL_COLORS = [
  [0.94, 0.63, 0.19, 1.0],
  [0.20, 0.68, 0.90, 1.0],
  [0.86, 0.44, 0.78, 1.0],
  [0.28, 0.78, 0.48, 1.0],
  [0.96, 0.38, 0.32, 1.0],
  [0.62, 0.52, 0.96, 1.0],
  [0.88, 0.76, 0.24, 1.0],
  [0.36, 0.78, 0.74, 1.0],
] as const
const RAPID_C     = [0.4,  0.5,  0.7,  1.0] as const
const TRAVERSE_C  = [0.35, 0.6,  0.35, 0.7] as const
const CUT_C       = [0.94, 0.63, 0.19, 1.0] as const

function toolColorIndex(tool: number) {
  const abs = Math.abs(tool)
  return (abs > 0 ? abs - 1 : 0) % TOOL_COLORS.length
}

function toBytes(color: readonly number[]) {
  return color.map(value => Math.round(value * 255))
}

const RAPID_BYTES = toBytes(RAPID_C)
const TRAVERSE_BYTES = toBytes(TRAVERSE_C)
const CUT_BYTES = toBytes(CUT_C)
const TOOL_BYTES = TOOL_COLORS.map(toBytes)

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function normalizeAngle(angle: number) {
  return ((angle % TAU) + TAU) % TAU
}

export function getArcGeometry(seg: Segment) {
  const cx = seg.x0 + (seg.i ?? 0)
  const cy = seg.y0 + (seg.j ?? 0)
  const r = Math.sqrt((seg.i ?? 0) ** 2 + (seg.j ?? 0) ** 2)
  const startAngle = Math.atan2(seg.y0 - cy, seg.x0 - cx)
  const endAngle = Math.atan2(seg.y1 - cy, seg.x1 - cx)
  const fullCircle = Math.abs(seg.x0 - seg.x1) < 1e-4 && Math.abs(seg.y0 - seg.y1) < 1e-4
  let sweep = seg.cw
    ? normalizeAngle(startAngle - endAngle)
    : normalizeAngle(endAngle - startAngle)
  if (fullCircle) sweep = TAU
  return { cx, cy, r, startAngle, endAngle, sweep, fullCircle }
}

export function addSegmentToPath(path: Path2D, seg: Segment) {
  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
    for (let i = 0; i < numSubs; i++) {
      const t1 = i / numSubs
      const t2 = (i + 1) / numSubs
      const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
      const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
      path.moveTo(
        arc.cx + Math.cos(angle1) * arc.r,
        arc.cy + Math.sin(angle1) * arc.r,
      )
      path.lineTo(
        arc.cx + Math.cos(angle2) * arc.r,
        arc.cy + Math.sin(angle2) * arc.r,
      )
    }
    return
  }

  path.moveTo(seg.x0, seg.y0)
  path.lineTo(seg.x1, seg.y1)
}

/**
 * The toolpath reduced to straight lines for drawing. Arcs are subdivided, and
 * consecutive collinear moves of the same kind are joined: a laser raster row
 * of thousands of power changes becomes a single line.
 */
export interface RenderLines {
  count: number
  /** x0, y0, z0, x1, y1, z1 per line. */
  positions: Float32Array
  /** MOVE_FEED / MOVE_RAPID / MOVE_TRAVERSE per line. */
  kinds: Uint8Array
  /** Tool per line, or NO_TOOL. */
  tools: Int32Array
  hasTools: boolean
}

class RenderLineWriter {
  count = 0
  positions: Float32Array
  kinds: Uint8Array
  tools: Int32Array
  /** Whether the last line came from a straight move and may be extended. */
  private extendable = false

  constructor(capacity: number) {
    capacity = Math.max(256, capacity)
    this.positions = new Float32Array(capacity * 6)
    this.kinds = new Uint8Array(capacity)
    this.tools = new Int32Array(capacity)
  }

  private ensureCapacity() {
    if (this.count < this.kinds.length) return
    const capacity = this.kinds.length * 2
    const positions = new Float32Array(capacity * 6)
    positions.set(this.positions)
    const kinds = new Uint8Array(capacity)
    kinds.set(this.kinds)
    const tools = new Int32Array(capacity)
    tools.set(this.tools)
    this.positions = positions
    this.kinds = kinds
    this.tools = tools
  }

  push(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: number, tool: number, extendable: boolean) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
    const lengthSq = dx * dx + dy * dy + dz * dz
    if (lengthSq === 0) return

    if (extendable && this.extendable) {
      const last = this.count - 1
      const p = this.positions
      const o = last * 6
      if (this.kinds[last] === kind && this.tools[last] === tool) {
        const lx = p[o + 3] - p[o], ly = p[o + 4] - p[o + 1], lz = p[o + 5] - p[o + 2]
        const dot = lx * dx + ly * dy + lz * dz
        if (dot > 0) {
          const cx = ly * dz - lz * dy, cy = lz * dx - lx * dz, cz = lx * dy - ly * dx
          const lastLengthSq = lx * lx + ly * ly + lz * lz
          if (cx * cx + cy * cy + cz * cz <= COLLINEAR_SIN_SQ * lastLengthSq * lengthSq) {
            p[o + 3] = x1
            p[o + 4] = y1
            p[o + 5] = z1
            return
          }
        }
      }
    }

    this.ensureCapacity()
    const o = this.count * 6
    const p = this.positions
    p[o] = x0; p[o + 1] = y0; p[o + 2] = z0
    p[o + 3] = x1; p[o + 4] = y1; p[o + 5] = z1
    this.kinds[this.count] = kind
    this.tools[this.count] = tool
    this.count++
    this.extendable = extendable
  }

  breakChain() {
    this.extendable = false
  }

  finish(hasTools: boolean): RenderLines {
    const count = this.count
    return {
      count,
      positions: this.positions.slice(0, count * 6),
      kinds: this.kinds.slice(0, count),
      tools: this.tools.slice(0, count),
      hasTools,
    }
  }
}

function appendRenderSegment(writer: RenderLineWriter, segments: SegmentTable, index: number) {
  const kind = segments.moveCode(index)
  const tool = segments.tools[index]
  if (!segments.isArc(index)) {
    writer.push(
      segments.px[index], segments.py[index], segments.pz[index],
      segments.px[index + 1], segments.py[index + 1], segments.pz[index + 1],
      kind, tool, true,
    )
    return
  }

  const seg = segments.get(index)
  const arc = getArcGeometry(seg)
  const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
  writer.breakChain()
  for (let i = 0; i < numSubs; i++) {
    const t1 = i / numSubs
    const t2 = (i + 1) / numSubs
    const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
    const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
    writer.push(
      arc.cx + Math.cos(angle1) * arc.r, arc.cy + Math.sin(angle1) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t1,
      arc.cx + Math.cos(angle2) * arc.r, arc.cy + Math.sin(angle2) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t2,
      kind, tool, false,
    )
  }
}

export async function buildRenderLinesAsync(
  segments: SegmentTable,
  onProgress: (progress: number) => void,
  shouldContinue: () => boolean,
): Promise<RenderLines> {
  const writer = new RenderLineWriter(Math.min(segments.length, 1 << 16))
  let deadline = performance.now() + BUILD_SLICE_MS
  for (let index = 0; index < segments.length; index++) {
    appendRenderSegment(writer, segments, index)
    if ((index + 1) % DEADLINE_CHECK_SEGMENTS === 0 && performance.now() >= deadline) {
      onProgress(Math.round(((index + 1) / segments.length) * 100))
      await yieldToEventLoop()
      if (!shouldContinue()) throw new Error('stale-load')
      deadline = performance.now() + BUILD_SLICE_MS
    }
  }
  onProgress(100)
  return writer.finish(segments.hasTools)
}

export function buildRenderLines(segments: SegmentTable): RenderLines {
  const writer = new RenderLineWriter(Math.min(segments.length, 1 << 16))
  for (let index = 0; index < segments.length; index++) appendRenderSegment(writer, segments, index)
  return writer.finish(segments.hasTools)
}

export interface Built2DPaths {
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

/** A Path2D that only starts a new subpath where the drawing is not continuous. */
class PolylinePath {
  readonly path = new Path2D()
  private lastX = NaN
  private lastY = NaN

  add(x0: number, y0: number, x1: number, y1: number) {
    if (x0 !== this.lastX || y0 !== this.lastY) this.path.moveTo(x0, y0)
    this.path.lineTo(x1, y1)
    this.lastX = x1
    this.lastY = y1
  }
}

interface PathSet {
  tool: number | null
  rapid: PolylinePath
  traverse: PolylinePath
  cut: PolylinePath
}

function createPathSet(tool: number | null): PathSet {
  return { tool, rapid: new PolylinePath(), traverse: new PolylinePath(), cut: new PolylinePath() }
}

function pathForKind(set: PathSet, kind: number) {
  return kind === MOVE_RAPID ? set.rapid : kind === MOVE_TRAVERSE ? set.traverse : set.cut
}

class Path2DBuilder {
  private readonly all = createPathSet(null)
  private readonly byTool: Map<number | null, PathSet> | null

  constructor(private readonly lines: RenderLines) {
    this.byTool = lines.hasTools ? new Map() : null
  }

  add(index: number) {
    const { positions, kinds, tools } = this.lines
    const o = index * 6
    const x0 = positions[o], y0 = positions[o + 1], x1 = positions[o + 3], y1 = positions[o + 4]
    const kind = kinds[index]
    pathForKind(this.all, kind).add(x0, y0, x1, y1)
    if (this.byTool) {
      const tool = tools[index] === NO_TOOL ? null : tools[index]
      let set = this.byTool.get(tool)
      if (!set) {
        set = createPathSet(tool)
        this.byTool.set(tool, set)
      }
      pathForKind(set, kind).add(x0, y0, x1, y1)
    }
  }

  finish(): Built2DPaths {
    return {
      rapidPath: this.all.rapid.path,
      traversePath: this.all.traverse.path,
      cutPath: this.all.cut.path,
      toolPaths: this.byTool
        ? Array.from(this.byTool.values())
          .sort((a, b) => (a.tool ?? -1) - (b.tool ?? -1))
          .map(set => ({ tool: set.tool, rapidPath: set.rapid.path, traversePath: set.traverse.path, cutPath: set.cut.path }))
        : undefined,
    }
  }
}

export async function buildStatic2DPathsAsync(
  lines: RenderLines,
  onProgress: (progress: number) => void,
  shouldContinue: () => boolean,
): Promise<Built2DPaths> {
  const builder = new Path2DBuilder(lines)
  let deadline = performance.now() + BUILD_SLICE_MS
  for (let index = 0; index < lines.count; index++) {
    builder.add(index)
    if ((index + 1) % DEADLINE_CHECK_SEGMENTS === 0 && performance.now() >= deadline) {
      onProgress(Math.round(((index + 1) / lines.count) * 100))
      await yieldToEventLoop()
      if (!shouldContinue()) throw new Error('stale-load')
      deadline = performance.now() + BUILD_SLICE_MS
    }
  }
  onProgress(100)
  return builder.finish()
}

export function buildStatic2DPaths(lines: RenderLines): Built2DPaths {
  const builder = new Path2DBuilder(lines)
  for (let index = 0; index < lines.count; index++) builder.add(index)
  return builder.finish()
}

export interface Built3DGeometry {
  vertices: Float32Array
  /** RGBA bytes per vertex, uploaded as normalized unsigned bytes. */
  colors: Uint8Array
}

function lineVisible(lines: RenderLines, index: number, showRapids: boolean, hiddenTools?: Set<number>) {
  if (!showRapids && lines.kinds[index] !== MOVE_FEED) return false
  const tool = lines.tools[index]
  return !(hiddenTools && hiddenTools.size > 0 && tool !== NO_TOOL && hiddenTools.has(tool))
}

function lineColor(kind: number, tool: number) {
  if (kind === MOVE_RAPID) return RAPID_BYTES
  if (kind === MOVE_TRAVERSE) return TRAVERSE_BYTES
  return tool === NO_TOOL ? CUT_BYTES : TOOL_BYTES[toolColorIndex(tool)]
}

export function buildStatic3DGeometry(
  lines: RenderLines,
  showRapids: boolean,
  hiddenTools?: Set<number>,
): Built3DGeometry {
  let visible = 0
  for (let index = 0; index < lines.count; index++) {
    if (lineVisible(lines, index, showRapids, hiddenTools)) visible++
  }
  if (visible === 0) return { vertices: EMPTY_FLOAT32, colors: EMPTY_UINT8 }

  const vertices = visible === lines.count ? lines.positions : new Float32Array(visible * 6)
  const colors = new Uint8Array(visible * 8)
  let out = 0
  for (let index = 0; index < lines.count; index++) {
    if (!lineVisible(lines, index, showRapids, hiddenTools)) continue
    if (visible !== lines.count) vertices.set(lines.positions.subarray(index * 6, index * 6 + 6), out * 6)
    const color = lineColor(lines.kinds[index], lines.tools[index])
    const c = out * 8
    colors[c] = colors[c + 4] = color[0]
    colors[c + 1] = colors[c + 5] = color[1]
    colors[c + 2] = colors[c + 6] = color[2]
    colors[c + 3] = colors[c + 7] = color[3]
    out++
  }
  return { vertices, colors }
}
