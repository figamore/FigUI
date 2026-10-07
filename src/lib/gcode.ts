/** Lightweight G-code parser – extracts toolpath segments for 2D visualisation. */

export type MoveType = 'rapid' | 'feed' | 'traverse'

export interface Segment {
  x0: number; y0: number; z0: number
  x1: number; y1: number; z1: number
  /** One-based physical row in the source G-code file. */
  sourceLine: number
  /**
   * G0 move = 'rapid'
   * G1/G2/G3 while spindle is on (or no spindle machine) = 'feed'
   * G1/G2/G3 while spindle is off on a spindle machine = 'traverse'
   */
  moveType: MoveType
  feedMmPerMin?: number
  /** G93 inverse-time duration for this move, before the feed override. */
  inverseTimeSeconds?: number
  /** Motion has no determinable feed rate (for example G95 without RPM). */
  timingUnknown?: boolean
  tool?: number
  /** For arcs: center offsets (relative to start). undefined for lines. */
  i?: number; j?: number; k?: number
  /** Active plane for an arc; omitted for the usual G17 XY plane. */
  arcPlane?: 17 | 18 | 19
  /** true = clockwise arc (G2) */
  cw?: boolean
}

export interface GCodeTool {
  number: number
  label: string
  sourceLine: number
}

export interface GCodeModel {
  segments: SegmentTable
  tools?: GCodeTool[]
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  totalLines: number
  /** Fixed controller waits that can be included in a runtime estimate. */
  fixedDelays?: Array<[sourceLine: number, seconds: number]>
  /** Spindle state changes; their configured controller delays are timed later. */
  spindleTransitions?: Array<[sourceLine: number, state: 'on' | 'off']>
  /** First M2/M30 source line; program content after it will not execute. */
  timingEndLine?: number
}

export type WorkCoordinateSystem = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' | 'G59.1' | 'G59.2' | 'G59.3'

export interface WorkOffset {
  x: number
  y: number
  z: number
}

export interface ParseGCodeOptions {
  activeWcs?: WorkCoordinateSystem
  currentWco?: WorkOffset
  workOffsets?: Partial<Record<WorkCoordinateSystem, WorkOffset>>
}

export const MOVE_FEED = 0
export const MOVE_RAPID = 1
export const MOVE_TRAVERSE = 2
const MOVE_TYPES: readonly MoveType[] = ['feed', 'rapid', 'traverse']

const FLAG_MOVE_MASK = 0b11
const FLAG_ARC = 1 << 2
const FLAG_CW = 1 << 3
const FLAG_PLANE_SHIFT = 4
const FLAG_PLANE_MASK = 0b11 << FLAG_PLANE_SHIFT
const FLAG_TIMING_UNKNOWN = 1 << 6
const FLAG_INVERSE_TIME = 1 << 7
const ARC_PLANES = [17, 18, 19] as const

/** Stored in `SegmentTable.tools` for moves made before any tool was selected. */
export const NO_TOOL = -0x80000000

/**
 * Parsed motion stored as typed arrays. Laser raster jobs routinely contain
 * millions of moves, and one JS object per move exhausts the browser's memory.
 *
 * Every move starts where the previous one ended, so the moves form a single
 * chain of points: move `i` runs from point `i` to point `i + 1`.
 */
export class SegmentTable {
  constructor(
    readonly length: number,
    readonly px: Float64Array,
    readonly py: Float64Array,
    readonly pz: Float64Array,
    readonly sourceLines: Uint32Array,
    readonly flags: Uint8Array,
    /** mm/min, or G93 seconds when the inverse-time flag is set; 0 when unknown. */
    readonly feeds: Float32Array,
    readonly tools: Int32Array,
    /** Index into `arcOffsets` (three values per arc), or -1 for straight moves. */
    readonly arcIndex: Int32Array,
    readonly arcOffsets: Float64Array,
    readonly hasTools: boolean,
  ) {}

  moveCode(index: number) {
    return this.flags[index] & FLAG_MOVE_MASK
  }

  moveType(index: number): MoveType {
    return MOVE_TYPES[this.flags[index] & FLAG_MOVE_MASK]
  }

  isArc(index: number) {
    return (this.flags[index] & FLAG_ARC) !== 0
  }

  tool(index: number): number | undefined {
    const tool = this.tools[index]
    return tool === NO_TOOL ? undefined : tool
  }

  sourceLine(index: number) {
    return this.sourceLines[index]
  }

  /** Same as `get(index).timingUnknown` without building the object. */
  timingUnknown(index: number) {
    return (this.flags[index] & FLAG_TIMING_UNKNOWN) !== 0
  }

  /** Same as `get(index).inverseTimeSeconds` without building the object. */
  inverseTimeSeconds(index: number): number | undefined {
    const flags = this.flags[index]
    return (flags & FLAG_MOVE_MASK) !== MOVE_RAPID && (flags & (FLAG_INVERSE_TIME | FLAG_TIMING_UNKNOWN)) === FLAG_INVERSE_TIME
      ? this.feeds[index]
      : undefined
  }

  /** Same as `get(index).feedMmPerMin` without building the object. */
  feedMmPerMin(index: number): number | undefined {
    const flags = this.flags[index]
    return (flags & FLAG_MOVE_MASK) !== MOVE_RAPID && (flags & (FLAG_INVERSE_TIME | FLAG_TIMING_UNKNOWN)) === 0 && this.feeds[index] > 0
      ? this.feeds[index]
      : undefined
  }

  /** Builds one move as a plain object. Avoid calling it for every move of a large job. */
  get(index: number): Segment {
    const flags = this.flags[index]
    const moveCode = flags & FLAG_MOVE_MASK
    const seg: Segment = {
      x0: this.px[index], y0: this.py[index], z0: this.pz[index],
      x1: this.px[index + 1], y1: this.py[index + 1], z1: this.pz[index + 1],
      moveType: MOVE_TYPES[moveCode],
      sourceLine: this.sourceLines[index],
    }
    if (flags & FLAG_ARC) {
      const arc = this.arcIndex[index] * 3
      seg.i = this.arcOffsets[arc]
      seg.j = this.arcOffsets[arc + 1]
      seg.k = this.arcOffsets[arc + 2]
      seg.cw = (flags & FLAG_CW) !== 0
      const plane = ARC_PLANES[(flags & FLAG_PLANE_MASK) >> FLAG_PLANE_SHIFT]
      if (plane !== 17) seg.arcPlane = plane
    }
    if (moveCode !== MOVE_RAPID) {
      if (flags & FLAG_TIMING_UNKNOWN) seg.timingUnknown = true
      else if (flags & FLAG_INVERSE_TIME) seg.inverseTimeSeconds = this.feeds[index]
      else if (this.feeds[index] > 0) seg.feedMmPerMin = this.feeds[index]
    }
    const tool = this.tools[index]
    if (tool !== NO_TOOL) seg.tool = tool
    return seg
  }

  static readonly EMPTY = new SegmentTable(
    0,
    new Float64Array(1), new Float64Array(1), new Float64Array(1),
    new Uint32Array(0), new Uint8Array(0), new Float32Array(0), new Int32Array(0), new Int32Array(0),
    new Float64Array(0),
    false,
  )
}

/** Map segment index → approximate source-line fraction (0..1) */
export function segmentProgress(idx: number, total: number): number {
  return total > 0 ? idx / total : 0
}

const WORK_COORDINATE_SYSTEMS = new Set<WorkCoordinateSystem>([
  'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3',
])

function normalizeWcs(code: string | undefined): WorkCoordinateSystem | undefined {
  if (!code) return undefined
  const upper = code.toUpperCase()
  return WORK_COORDINATE_SYSTEMS.has(upper as WorkCoordinateSystem)
    ? upper as WorkCoordinateSystem
    : undefined
}

function wcsFromGValue(g: number): WorkCoordinateSystem | null {
  if (g === 54) return 'G54'
  if (g === 55) return 'G55'
  if (g === 56) return 'G56'
  if (g === 57) return 'G57'
  if (g === 58) return 'G58'
  if (g === 59) return 'G59'
  if (g === 59.1) return 'G59.1'
  if (g === 59.2) return 'G59.2'
  if (g === 59.3) return 'G59.3'
  return null
}

function getShift(
  wcs: WorkCoordinateSystem | undefined,
  activeWcs: WorkCoordinateSystem | undefined,
  currentWco: WorkOffset,
  workOffsets: Partial<Record<WorkCoordinateSystem, WorkOffset>>,
): WorkOffset {
  if (!wcs || wcs === activeWcs) return { x: 0, y: 0, z: 0 }
  const target = workOffsets[wcs]
  if (!target) return { x: 0, y: 0, z: 0 }
  return {
    x: target.x - currentWco.x,
    y: target.y - currentWco.y,
    z: target.z - currentWco.z,
  }
}

function stripComments(raw: string) {
  const comments: string[] = []
  const withoutParens = raw.replace(/\(([^)]*)\)/g, (_match, comment) => {
    comments.push(String(comment).trim())
    return ' '
  })
  const semicolon = withoutParens.indexOf(';')
  if (semicolon >= 0) {
    comments.push(withoutParens.slice(semicolon + 1).trim())
    return { code: withoutParens.slice(0, semicolon), comments }
  }
  return { code: withoutParens, comments }
}

function cleanToolName(value: string | undefined) {
  const cleaned = (value ?? '')
    .replace(/\b[GMTXYZIJKRFSPH]\s*-?(?:\d+\.?\d*|\.\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

function toolLabel(tool: number, name: string | null) {
  return name ? `T${tool} ${name}` : `T${tool}`
}

// Word letters are indexed A=0 … Z=25.
const W_F = 5, W_I = 8, W_J = 9, W_K = 10, W_P = 15, W_R = 17, W_S = 18, W_T = 19, W_X = 23, W_Y = 24, W_Z = 25
const HAS_F = 1 << W_F
const HAS_I = 1 << W_I
const HAS_J = 1 << W_J
const HAS_K = 1 << W_K
const HAS_P = 1 << W_P
const HAS_R = 1 << W_R
const HAS_S = 1 << W_S
const HAS_T = 1 << W_T
const HAS_X = 1 << W_X
const HAS_Y = 1 << W_Y
const HAS_Z = 1 << W_Z
const INCH_SCALED_WORDS = [W_X, W_Y, W_Z, W_I, W_J, W_K, W_R]

const POW10 = Array.from({ length: 23 }, (_, power) => 10 ** power)
const CH_LPAREN = 40
const CH_MINUS = 45
const CH_DOT = 46
const CH_0 = 48
const CH_9 = 57
const CH_SEMICOLON = 59
const CH_A = 65
const CH_G = 71
const CH_M = 77
const CH_Z = 90
const CH_LOWER_A = 97
const CH_LOWER_Z = 122
/** Lines between deadline checks while parsing in time slices. */
const DEADLINE_CHECK_LINES = 512

/**
 * Incremental parser. `parseUntil` can be called repeatedly with a time budget
 * so multi-million-line files never block the page for long.
 */
export class GCodeParser {
  private pos = 0
  private lineIndex = 0
  private done = false

  // Machine state
  private x = 0; private y = 0; private z = 0
  private offX = 0; private offY = 0; private offZ = 0   // G92 coordinate offsets
  private readonly optionActiveWcs: WorkCoordinateSystem | undefined
  private readonly currentWco: WorkOffset
  private readonly workOffsets: Partial<Record<WorkCoordinateSystem, WorkOffset>>
  private wcsShift: WorkOffset
  private rapid = true
  private arcMode: 0 | 2 | 3 = 0   // 0 = linear, 2 = CW arc, 3 = CCW arc
  private plane: 17 | 18 | 19 = 17 // G17=XY, G18=ZX, G19=YZ
  private incremental = false
  private inchMode = false         // G20=inches, G21=mm
  private spindleOn = false
  private spindleEverOn = false    // false = no spindle machine e.g. pen plotter
  private feedMmPerMin = 0
  private feedMmPerRev = 0
  private spindleRpm: number | null = null
  private feedRateMode: 93 | 94 | 95 = 94
  private pendingTool: number | null = null
  private activeTool: number | null = null
  private sawToolChange = false
  private readonly toolMap = new Map<number, GCodeTool>()
  private readonly fixedDelays: Array<[number, number]> = []
  private readonly spindleTransitions: Array<[number, 'on' | 'off']> = []
  private timingEndLine: number | undefined
  private readonly bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }

  // Per-line scratch
  private wordMask = 0
  private readonly words = new Float64Array(26)
  private readonly gCodes: number[] = []
  private readonly mCodes: number[] = []
  private numberEnd = 0

  // Output, sized once the lines have been counted
  private countPos = 0
  private lineCount = 1
  private allocated = false
  private count = 0
  private capacity = 0
  private px = new Float64Array(1)
  private py = new Float64Array(1)
  private pz = new Float64Array(1)
  private sourceLines = new Uint32Array(0)
  private flags = new Uint8Array(0)
  private feeds = new Float32Array(0)
  private tools = new Int32Array(0)
  private arcIndex = new Int32Array(0)
  private arcOffsets = new Float64Array(3 * 256)
  private arcCount = 0
  private hasTools = false

  constructor(private readonly text: string, options: ParseGCodeOptions = {}) {
    const activeWcs = normalizeWcs(options.activeWcs) ?? 'G54'
    this.optionActiveWcs = normalizeWcs(options.activeWcs)
    this.currentWco = options.currentWco ?? { x: 0, y: 0, z: 0 }
    this.workOffsets = options.workOffsets ?? {}
    this.wcsShift = getShift(activeWcs, activeWcs, this.currentWco, this.workOffsets)
  }

  /** Fraction of the source text consumed so far (0..1). */
  get progress() {
    return this.text.length > 0 ? this.pos / this.text.length : 1
  }

  /**
   * Each line produces at most one move, so counting lines first sizes the
   * output exactly instead of growing (and briefly doubling) huge arrays.
   */
  private countLines(deadline: number) {
    const text = this.text
    let pos = this.countPos
    let sinceCheck = 0
    for (let next = text.indexOf('\n', pos); next >= 0; next = text.indexOf('\n', pos)) {
      this.lineCount++
      pos = next + 1
      if (++sinceCheck >= DEADLINE_CHECK_LINES * 8) {
        sinceCheck = 0
        if (performance.now() >= deadline) {
          this.countPos = pos
          return false
        }
      }
    }
    const capacity = this.lineCount
    this.capacity = capacity
    this.px = new Float64Array(capacity + 1)
    this.py = new Float64Array(capacity + 1)
    this.pz = new Float64Array(capacity + 1)
    this.sourceLines = new Uint32Array(capacity)
    this.flags = new Uint8Array(capacity)
    this.feeds = new Float32Array(capacity)
    this.tools = new Int32Array(capacity)
    this.arcIndex = new Int32Array(capacity)
    this.allocated = true
    return true
  }

  /** Parses lines until `deadline` (a `performance.now()` value). Returns true when finished. */
  parseUntil(deadline = Infinity) {
    if (!this.allocated && !this.countLines(deadline)) return false
    const text = this.text
    const length = text.length
    let sinceCheck = 0
    while (!this.done) {
      let end = text.indexOf('\n', this.pos)
      if (end < 0) end = length
      this.parseLine(this.pos, end, this.lineIndex + 1)
      this.lineIndex++
      if (end >= length) {
        this.done = true
        this.pos = length
        break
      }
      this.pos = end + 1
      if (++sinceCheck >= DEADLINE_CHECK_LINES) {
        sinceCheck = 0
        if (performance.now() >= deadline) break
      }
    }
    return this.done
  }

  finish(): GCodeModel {
    this.parseUntil()
    const n = this.count
    // Release over-allocated capacity when it is a significant share of memory.
    const trim = n < this.capacity * 0.75
    const cut = <T extends Float64Array | Float32Array | Uint32Array | Uint8Array | Int32Array>(array: T, size: number): T =>
      (trim ? array.slice(0, size) : array.subarray(0, size)) as T
    const segments = new SegmentTable(
      n,
      cut(this.px, n + 1), cut(this.py, n + 1), cut(this.pz, n + 1),
      cut(this.sourceLines, n),
      cut(this.flags, n),
      cut(this.feeds, n),
      cut(this.tools, n),
      cut(this.arcIndex, n),
      this.arcOffsets.slice(0, this.arcCount * 3),
      this.hasTools,
    )

    const bounds = this.bounds
    // Handle degenerate case
    if (!isFinite(bounds.minX)) {
      bounds.minX = bounds.minY = bounds.minZ = 0
      bounds.maxX = bounds.maxY = bounds.maxZ = 1
    }

    return {
      segments,
      tools: this.toolMap.size > 0 ? Array.from(this.toolMap.values()).sort((a, b) => a.number - b.number) : undefined,
      bounds,
      totalLines: this.lineIndex,
      fixedDelays: this.fixedDelays,
      spindleTransitions: this.spindleTransitions,
      timingEndLine: this.timingEndLine,
    }
  }

  private expandBounds(px: number, py: number, pz: number) {
    const bounds = this.bounds
    if (px < bounds.minX) bounds.minX = px
    if (px > bounds.maxX) bounds.maxX = px
    if (py < bounds.minY) bounds.minY = py
    if (py > bounds.maxY) bounds.maxY = py
    if (pz < bounds.minZ) bounds.minZ = pz
    if (pz > bounds.maxZ) bounds.maxZ = pz
  }

  /**
   * Reads `-?(?:\d+\.?\d*|\.\d+)` starting at `start`. Returns NaN when no
   * number is present; otherwise stores the index after it in `numberEnd`.
   */
  private scanNumber(start: number, end: number) {
    const text = this.text
    let index = start
    let negative = false
    if (index < end && text.charCodeAt(index) === CH_MINUS) {
      negative = true
      index++
    }
    let mantissa = 0
    let digits = 0
    let fractionDigits = 0
    let code = index < end ? text.charCodeAt(index) : 0
    while (code >= CH_0 && code <= CH_9) {
      mantissa = mantissa * 10 + (code - CH_0)
      digits++
      index++
      code = index < end ? text.charCodeAt(index) : 0
    }
    if (code === CH_DOT) {
      const next = index + 1 < end ? text.charCodeAt(index + 1) : 0
      if (digits === 0 && !(next >= CH_0 && next <= CH_9)) return NaN
      index++
      code = next
      while (code >= CH_0 && code <= CH_9) {
        mantissa = mantissa * 10 + (code - CH_0)
        digits++
        fractionDigits++
        index++
        code = index < end ? text.charCodeAt(index) : 0
      }
    } else if (digits === 0) {
      return NaN
    }
    this.numberEnd = index
    // Integer ÷ power of ten is correctly rounded, matching parseFloat, while
    // both stay exactly representable.
    const value = digits <= 15
      ? mantissa / POW10[fractionDigits]
      : parseFloat(text.slice(negative ? start + 1 : start, index))
    return negative ? -value : value
  }

  /** Splits a line into words with the same rules as the original regex-based parser. */
  private scanWords(start: number, end: number) {
    const text = this.text
    const words = this.words
    const gCodes = this.gCodes
    const mCodes = this.mCodes
    gCodes.length = 0
    mCodes.length = 0
    let mask = 0
    let index = start
    while (index < end) {
      let code = text.charCodeAt(index)
      if (code === CH_LPAREN) {
        const close = text.indexOf(')', index + 1)
        if (close >= 0 && close < end) {
          index = close + 1
          continue
        }
      } else if (code === CH_SEMICOLON) {
        break
      } else {
        if (code >= CH_LOWER_A && code <= CH_LOWER_Z) code -= 32
        if (code >= CH_A && code <= CH_Z) {
          const value = this.scanNumber(index + 1, end)
          if (value === value) {
            if (code === CH_G) gCodes.push(value)
            else if (code === CH_M) mCodes.push(value)
            else {
              const letter = code - CH_A
              words[letter] = value
              mask |= 1 << letter
            }
            index = this.numberEnd
            continue
          }
        }
      }
      index++
    }
    this.wordMask = mask
  }

  private pushSegment(
    x: number, y: number, z: number,
    sourceLine: number,
    flags: number,
    feed: number,
    arcI?: number, arcJ?: number, arcK?: number,
  ) {
    const index = this.count++
    this.px[index + 1] = x
    this.py[index + 1] = y
    this.pz[index + 1] = z
    this.sourceLines[index] = sourceLine
    this.flags[index] = flags
    this.feeds[index] = feed
    const tool = this.activeTool
    if (tool == null) {
      this.tools[index] = NO_TOOL
    } else {
      this.tools[index] = tool
      this.hasTools = true
    }
    if (arcI === undefined) {
      this.arcIndex[index] = -1
      return
    }
    if ((this.arcCount + 1) * 3 > this.arcOffsets.length) {
      const grown = new Float64Array(this.arcOffsets.length * 2)
      grown.set(this.arcOffsets)
      this.arcOffsets = grown
    }
    const arc = this.arcCount++
    this.arcIndex[index] = arc
    this.arcOffsets[arc * 3] = arcI
    this.arcOffsets[arc * 3 + 1] = arcJ ?? 0
    this.arcOffsets[arc * 3 + 2] = arcK ?? 0
  }

  private parseLine(start: number, end: number, sourceLine: number) {
    this.scanWords(start, end)
    const mask = this.wordMask
    const words = this.words
    const gCodes = this.gCodes
    const mCodes = this.mCodes
    if (mask === 0 && gCodes.length === 0 && mCodes.length === 0) return

    // Tool naming needs the comment text; such lines are rare.
    let stripped: ReturnType<typeof stripComments> | null = null
    const getStripped = () => stripped ??= stripComments(this.text.slice(start, end))

    if (mask & HAS_T) {
      this.pendingTool = Math.trunc(words[W_T])
      if (!this.sawToolChange) {
        const activeTool = this.pendingTool
        this.activeTool = activeTool
        if (!this.toolMap.has(activeTool)) {
          this.toolMap.set(activeTool, { number: activeTool, label: toolLabel(activeTool, cleanToolName(getStripped().comments[0])), sourceLine })
        }
      }
    }

    // Process M codes (spindle control)
    for (const mc of mCodes) {
      if (mc === 3 || mc === 4) {
        if (!this.spindleOn) this.spindleTransitions.push([sourceLine, 'on'])
        this.spindleOn = true; this.spindleEverOn = true
      }  // M3/M4 = spindle on
      else if (mc === 5) {
        if (this.spindleOn) this.spindleTransitions.push([sourceLine, 'off'])
        this.spindleOn = false
      }        // M5 = spindle off
      else if (mc === 6 && this.pendingTool != null) {
        const activeTool = this.pendingTool
        this.activeTool = activeTool
        this.sawToolChange = true
        const comments = getStripped()
        const name = cleanToolName(comments.comments[0]) ?? cleanToolName(comments.code)
        const existing = this.toolMap.get(activeTool)
        if (!existing || existing.label === `T${activeTool}`) {
          this.toolMap.set(activeTool, { number: activeTool, label: toolLabel(activeTool, name), sourceLine })
        }
      }
    }

    // Process G codes
    let hasG2 = false, hasG3 = false, hasG4 = false, hasG28 = false, hasG92 = false
    for (const g of gCodes) {
      if (g === 90) { this.incremental = false; continue }
      if (g === 91) { this.incremental = true; continue }
      if (g === 20) { this.inchMode = true; continue }
      if (g === 21) { this.inchMode = false; continue }
      if (g === 93 || g === 94 || g === 95) {
        this.feedRateMode = g
        continue
      }
      if (g === 17 || g === 18 || g === 19) { this.plane = g; continue }
      if (g === 4) { hasG4 = true; continue }
      if (g === 28) { hasG28 = true; continue }
      if (g === 92) { hasG92 = true; continue }
      const nextWcs = wcsFromGValue(g)
      if (nextWcs) {
        this.wcsShift = getShift(nextWcs, this.optionActiveWcs, this.currentWco, this.workOffsets)
        continue
      }
      if (g === 0) { this.rapid = true; this.arcMode = 0 }
      else if (g === 1) { this.rapid = false; this.arcMode = 0 }
      else if (g === 2) { this.rapid = false; this.arcMode = 2; hasG2 = true }
      else if (g === 3) { this.rapid = false; this.arcMode = 3; hasG3 = true }
    }

    if (this.inchMode) {
      for (const letter of INCH_SCALED_WORDS) {
        if (mask & (1 << letter)) words[letter] *= 25.4
      }
      if (this.feedRateMode !== 93 && (mask & HAS_F)) words[W_F] *= 25.4
    }

    if ((mask & HAS_F) && words[W_F] > 0) {
      if (this.feedRateMode === 95) this.feedMmPerRev = words[W_F]
      else if (this.feedRateMode !== 93) this.feedMmPerMin = words[W_F]
    }
    if ((mask & HAS_S) && words[W_S] >= 0) this.spindleRpm = words[W_S]

    if (hasG4 && (mask & HAS_P) && words[W_P] >= 0) {
      this.fixedDelays.push([sourceLine, words[W_P]])
    }

    if (this.timingEndLine == null && mCodes.some(code => code === 2 || code === 30)) {
      this.timingEndLine = sourceLine
    }

    const shift = this.wcsShift

    // G92 – set coordinate offset
    if (hasG92) {
      this.offX = this.x - shift.x - ((mask & HAS_X) ? words[W_X] : (this.x - shift.x))
      this.offY = this.y - shift.y - ((mask & HAS_Y) ? words[W_Y] : (this.y - shift.y))
      this.offZ = this.z - shift.z - ((mask & HAS_Z) ? words[W_Z] : (this.z - shift.z))
      return
    }

    if (hasG28) {
      // Reference-return distance depends on the current machine position and
      // configured G28 point. It is omitted from the best-effort estimate.
      return
    }

    const plane = this.plane
    const hasMove = (mask & (HAS_X | HAS_Y | HAS_Z)) !== 0
    const hasArcCenter = plane === 17
      ? (mask & (HAS_I | HAS_J | HAS_R)) !== 0
      : plane === 18
        ? (mask & (HAS_I | HAS_K | HAS_R)) !== 0
        : (mask & (HAS_J | HAS_K | HAS_R)) !== 0
    const isArc = hasG2 || hasG3 || (this.arcMode > 0 && hasMove && hasArcCenter)
    if (!hasMove && !isArc) return

    const x0 = this.x, y0 = this.y, z0 = this.z
    let x: number, y: number, z: number
    if (this.incremental) {
      x = x0 + ((mask & HAS_X) ? words[W_X] : 0)
      y = y0 + ((mask & HAS_Y) ? words[W_Y] : 0)
      z = z0 + ((mask & HAS_Z) ? words[W_Z] : 0)
    } else {
      x = ((mask & HAS_X) ? words[W_X] : (x0 - shift.x - this.offX)) + this.offX + shift.x
      y = ((mask & HAS_Y) ? words[W_Y] : (y0 - shift.y - this.offY)) + this.offY + shift.y
      z = ((mask & HAS_Z) ? words[W_Z] : (z0 - shift.z - this.offZ)) + this.offZ + shift.z
    }
    this.x = x; this.y = y; this.z = z

    this.expandBounds(x0, y0, z0)
    this.expandBounds(x, y, z)

    const moveCode = this.rapid ? MOVE_RAPID : this.spindleEverOn && !this.spindleOn ? MOVE_TRAVERSE : MOVE_FEED
    let flags = moveCode
    let feed = 0
    if (moveCode !== MOVE_RAPID) {
      if (this.feedRateMode === 93) {
        if ((mask & HAS_F) && words[W_F] > 0) {
          flags |= FLAG_INVERSE_TIME
          feed = 60 / words[W_F]
        } else {
          flags |= FLAG_TIMING_UNKNOWN
        }
      } else if (this.feedRateMode === 95) {
        if (this.feedMmPerRev > 0 && this.spindleRpm != null && this.spindleRpm > 0) {
          feed = this.feedMmPerRev * this.spindleRpm
        } else {
          flags |= FLAG_TIMING_UNKNOWN
        }
      } else if (this.feedMmPerMin > 0) {
        feed = this.feedMmPerMin
      }
    }

    if (!isArc) {
      this.pushSegment(x, y, z, sourceLine, flags, feed)
      return
    }

    const cw = hasG2 || (!hasG3 && this.arcMode === 2)
    let i: number, j: number, k = 0
    if (mask & HAS_R) {
      // R-format arc: compute offsets in the active plane.
      const R = words[W_R]
      const [u0, v0, u1, v1] = plane === 17
        ? [x0, y0, x, y]
        : plane === 18 ? [x0, z0, x, z] : [y0, z0, y, z]
      const du = u1 - u0, dv = v1 - v0
      const d = Math.hypot(du, dv)
      if (d > 0) {
        const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4))
        const sign = ((R > 0) !== cw) ? 1 : -1
        const offsetU = du / 2 + sign * h * (-dv / d)
        const offsetV = dv / 2 + sign * h * (du / d)
        if (plane === 17) { i = offsetU; j = offsetV; k = 0 }
        else if (plane === 18) { i = offsetU; j = 0; k = offsetV }
        else { i = 0; j = offsetU; k = offsetV }
      } else {
        i = 0; j = 0; k = 0
      }
    } else {
      i = (mask & HAS_I) ? words[W_I] : 0
      j = (mask & HAS_J) ? words[W_J] : 0
      k = (mask & HAS_K) ? words[W_K] : 0
    }

    // Skip arcs with zero radius (degenerate)
    const r = Math.sqrt(i * i + j * j + k * k)
    if (r <= 1e-6) {
      // Treat degenerate arc as a line
      this.pushSegment(x, y, z, sourceLine, flags, feed)
      return
    }

    const isFullCircle = plane === 17
      ? Math.abs(x0 - x) < 1e-4 && Math.abs(y0 - y) < 1e-4
      : plane === 18
        ? Math.abs(x0 - x) < 1e-4 && Math.abs(z0 - z) < 1e-4
        : Math.abs(y0 - y) < 1e-4 && Math.abs(z0 - z) < 1e-4
    if (isFullCircle) {
      if (plane === 17) {
        const cx = x0 + i, cy = y0 + j
        this.expandBounds(cx + r, cy, z0)
        this.expandBounds(cx - r, cy, z0)
        this.expandBounds(cx, cy + r, z0)
        this.expandBounds(cx, cy - r, z0)
      } else if (plane === 18) {
        const cx = x0 + i, cz = z0 + k
        this.expandBounds(cx + r, y0, cz)
        this.expandBounds(cx - r, y0, cz)
        this.expandBounds(cx, y0, cz + r)
        this.expandBounds(cx, y0, cz - r)
      } else {
        const cy = y0 + j, cz = z0 + k
        this.expandBounds(x0, cy + r, cz)
        this.expandBounds(x0, cy - r, cz)
        this.expandBounds(x0, cy, cz + r)
        this.expandBounds(x0, cy, cz - r)
      }
    } else if (plane === 17) {
      // Expand G17 bounds to include cardinal extrema that fall within
      // the arc's sweep. Other planes retain endpoint bounds here.
      const cx = x0 + i, cy = y0 + j
      const sa = Math.atan2(y0 - cy, x0 - cx)
      const ea = Math.atan2(y - cy, x - cx)
      const TAU = Math.PI * 2
      const sweep = cw
        ? ((sa - ea) % TAU + TAU) % TAU
        : ((ea - sa) % TAU + TAU) % TAU
      for (let n = 0; n < 4; n++) {
        const angle = n * Math.PI / 2
        const delta = cw
          ? ((sa - angle) % TAU + TAU) % TAU
          : ((angle - sa) % TAU + TAU) % TAU
        if (delta <= sweep + 1e-9) {
          this.expandBounds(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, z0)
        }
      }
    }

    flags |= FLAG_ARC | (cw ? FLAG_CW : 0) | ((plane - 17) << FLAG_PLANE_SHIFT)
    this.pushSegment(x, y, z, sourceLine, flags, feed, i, j, k)
  }
}

export function parseGCode(text: string, options: ParseGCodeOptions = {}): GCodeModel {
  return new GCodeParser(text, options).finish()
}

/** Gives the browser a chance to paint and handle input between work slices. */
export function yieldToEventLoop() {
  return new Promise<void>(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * Parses in short time slices so the page stays responsive. Throws
 * `Error('stale-load')` when `shouldContinue` turns false.
 */
export async function parseGCodeAsync(
  text: string,
  options: ParseGCodeOptions,
  onProgress: (fraction: number) => void,
  shouldContinue: () => boolean,
  sliceMs = 12,
): Promise<GCodeModel> {
  const parser = new GCodeParser(text, options)
  while (!parser.parseUntil(performance.now() + sliceMs)) {
    onProgress(parser.progress)
    await yieldToEventLoop()
    if (!shouldContinue()) throw new Error('stale-load')
  }
  onProgress(1)
  return parser.finish()
}
