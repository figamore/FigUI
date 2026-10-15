type ToolLengthMode = { mode: 'G49' } | { mode: 'G43'; h: number | null }

export interface RestartModalState {
  units: 'G20' | 'G21'
  distance: 'G90' | 'G91'
  arcDistance: 'G90.1' | 'G91.1'
  plane: 'G17' | 'G18' | 'G19'
  feedMode: 'G93' | 'G94' | 'G95'
  motion: 'G0' | 'G1' | 'G2' | 'G3'
  /** Null when the program selects no work offset before the line; the controller's active one stays in force. */
  wcs: string | null
  cutterComp: 'G40' | 'G41' | 'G42'
  cannedCycle: string
  /** Null when the program sets no tool-length mode before the line; the controller's offset is left alone. */
  toolLength: ToolLengthMode | null
  tool: number | null
  feedMmPerMin: number | null
  spindleSpeed: number | null
  spindle: 'M3' | 'M4' | 'M5'
  coolant: Array<'M7' | 'M8'>
  positionMm: { x: number; y: number; z: number }
}

export interface RestartAnalysis {
  requestedLine: number
  resumeLine: number
  totalLines: number
  resumeText: string
  context: Array<{ line: number; text: string; resume: boolean }>
  state: RestartModalState
  /** False when no line commands Z, as in hand-focused laser jobs. The restart then leaves Z alone. */
  movesZ: boolean
  warnings: string[]
  blockers: string[]
}

export interface RestartProgramOptions {
  sourceName: string
  sourcePath: string
  safeMachineZMm: number
  clearanceMm: number
  approachFeedMmPerMin: number
}

interface MutableState extends Omit<RestartModalState, 'wcs' | 'toolLength' | 'coolant' | 'positionMm'> {
  wcs: string
  toolLength: ToolLengthMode
  coolant: Set<'M7' | 'M8'>
  positionMm: { x: number; y: number; z: number }
  positionKnown: { x: boolean; y: boolean; z: boolean }
  pendingTool: number | null
  dynamicToolLength: boolean
  seen: Set<string>
}

interface Word {
  letter: string
  value: number
}

const WORD_RE = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi
const WCS_CODES = new Set(['54', '55', '56', '57', '58', '59', '59.1', '59.2', '59.3'])
const CANNED_CODES = new Set(['80', '81', '82', '83', '84', '85', '86', '87', '88', '89'])

function normalizedLines(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.length ? lines : ['']
}

/** Remove semicolon and parenthesized comments while preserving executable words. */
function stripComments(raw: string) {
  if (!raw.includes('(') && !raw.includes(';')) return raw.trim().toUpperCase()
  let result = ''
  let depth = 0
  for (const char of raw) {
    if (char === ';' && depth === 0) break
    if (char === '(') { depth++; continue }
    if (char === ')' && depth > 0) { depth--; continue }
    if (depth === 0) result += char
  }
  return result.trim().toUpperCase()
}

function wordsIn(code: string): Word[] {
  const words: Word[] = []
  WORD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_RE.exec(code)) !== null) {
    words.push({ letter: match[1].toUpperCase(), value: Number(match[2]) })
  }
  return words
}

function codeValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '')
}

function isExecutable(raw: string) {
  const code = stripComments(raw).replace(/^\s*%\s*$/, '').trim()
  if (!code) return false
  return wordsIn(code).some(word => word.letter !== 'N')
}

function fmt(value: number, decimals = 4) {
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value
  return normalized.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function defaultState(): MutableState {
  return {
    units: 'G21',
    distance: 'G90',
    arcDistance: 'G91.1',
    plane: 'G17',
    feedMode: 'G94',
    motion: 'G0',
    wcs: 'G54',
    cutterComp: 'G40',
    cannedCycle: 'G80',
    toolLength: { mode: 'G49' },
    tool: null,
    pendingTool: null,
    feedMmPerMin: null,
    spindleSpeed: null,
    spindle: 'M5',
    coolant: new Set(),
    positionMm: { x: 0, y: 0, z: 0 },
    positionKnown: { x: false, y: false, z: false },
    dynamicToolLength: false,
    seen: new Set(),
  }
}

function cloneState(state: MutableState): MutableState {
  return {
    ...state,
    toolLength: { ...state.toolLength },
    coolant: new Set(state.coolant),
    positionMm: { ...state.positionMm },
    positionKnown: { ...state.positionKnown },
    seen: new Set(state.seen),
  }
}

function addUnique(target: string[], message: string) {
  if (!target.includes(message)) target.push(message)
}

/** Prefix state is saved every this many lines, so analyzing a line replays at most this many. */
const CHECKPOINT_LINES = 5000

interface ProgramScan {
  text: string
  lines: string[]
  movesZ: boolean
  /** Blockers that apply to every restart line of the program. */
  blockers: string[]
  /** checkpoints[k] holds the state before line index k * CHECKPOINT_LINES. */
  checkpoints: Array<{ state: MutableState; blockers: string[] }>
}

let lastScan: ProgramScan | null = null

/** The dialog analyzes many lines of one program; scan the parts that do not depend on the line once. */
function scanProgram(text: string): ProgramScan {
  if (lastScan?.text === text) return lastScan
  const lines = normalizedLines(text)
  const blockers: string[] = []
  const movesZ = scanProgramWideSafety(lines, blockers)
  lastScan = { text, lines, movesZ, blockers, checkpoints: [{ state: defaultState(), blockers: [] }] }
  return lastScan
}

/** Releases the cached scan (the program text, its lines and checkpoints) once the dialog closes. */
export function clearRestartScanCache() {
  lastScan = null
}

function prefixStateBefore(scan: ProgramScan, resumeIndex: number) {
  const { checkpoints } = scan
  const start = Math.min(checkpoints.length - 1, Math.floor(resumeIndex / CHECKPOINT_LINES))
  const state = cloneState(checkpoints[start].state)
  const blockers = [...checkpoints[start].blockers]
  for (let index = start * CHECKPOINT_LINES; index < resumeIndex; index++) {
    applyPrefixLine(scan.lines[index], state, blockers)
    if (index + 1 === checkpoints.length * CHECKPOINT_LINES) {
      checkpoints.push({ state: cloneState(state), blockers: [...blockers] })
    }
  }
  return { state, blockers }
}

/** Reports program-wide blockers and returns whether any line commands Z. */
function scanProgramWideSafety(lines: string[], blockers: string[]) {
  let movesZ = false
  for (let index = 0; index < lines.length; index++) {
    const code = stripComments(lines[index])
    if (!code) continue
    const line = index + 1
    if (!movesZ && code.includes('Z') && wordsIn(code).some(word => word.letter === 'Z')) movesZ = true
    if (code.includes('#') || /\b(?:IF|WHILE|ENDWHILE|GOTO|CALL|RETURN)\b/.test(code)) {
      addUnique(blockers, `Line ${line} uses macro or conditional syntax, which cannot be reconstructed safely.`)
    }
    if (/\bM(?:98|99)(?:\.0*)?\b/.test(code)) {
      addUnique(blockers, `Line ${line} calls or returns from a subprogram. Restart copies cannot safely remove its preceding definitions.`)
    }
    if (/\bG(?:65|66|67)(?:\.0*)?\b/.test(code)) {
      addUnique(blockers, `Line ${line} uses a macro call or modal macro.`)
    }
    if (wordsIn(code).some(word => ['A', 'B', 'C', 'U', 'V', 'W'].includes(word.letter))) {
      addUnique(blockers, `Line ${line} contains a rotary or auxiliary axis. This restart version supports XYZ programs only.`)
    }
  }
  return movesZ
}

function applyPrefixLine(raw: string, state: MutableState, blockers: string[]) {
  const code = stripComments(raw)
  if (!code) return
  const words = wordsIn(code)
  const gCodes = words.filter(word => word.letter === 'G').map(word => codeValue(word.value))
  const mCodes = words.filter(word => word.letter === 'M').map(word => Math.trunc(word.value))
  const value = (letter: string) => {
    const found = [...words].reverse().find(word => word.letter === letter)
    return found?.value
  }

  for (const g of gCodes) {
    if (g === '20' || g === '21') { state.units = `G${g}` as 'G20' | 'G21'; state.seen.add('units') }
    else if (g === '90' || g === '91') { state.distance = `G${g}` as 'G90' | 'G91'; state.seen.add('distance') }
    else if (g === '90.1' || g === '91.1') { state.arcDistance = `G${g}` as 'G90.1' | 'G91.1'; state.seen.add('arcDistance') }
    else if (g === '17' || g === '18' || g === '19') { state.plane = `G${g}` as 'G17' | 'G18' | 'G19'; state.seen.add('plane') }
    else if (g === '93' || g === '94' || g === '95') { state.feedMode = `G${g}` as 'G93' | 'G94' | 'G95'; state.seen.add('feedMode') }
    else if (g === '0' || g === '1' || g === '2' || g === '3') { state.motion = `G${g}` as 'G0' | 'G1' | 'G2' | 'G3'; state.seen.add('motion') }
    else if (WCS_CODES.has(g)) {
      const nextWcs = `G${g}`
      if (nextWcs !== state.wcs) {
        state.positionKnown = { x: false, y: false, z: false }
      }
      state.wcs = nextWcs
      state.seen.add('wcs')
    } else if (g === '40' || g === '41' || g === '42') {
      state.cutterComp = `G${g}` as 'G40' | 'G41' | 'G42'
    } else if (CANNED_CODES.has(g)) {
      state.cannedCycle = `G${g}`
    } else if (g === '49') {
      state.toolLength = { mode: 'G49' }
      state.dynamicToolLength = false
      state.seen.add('toolLength')
    } else if (g === '43') {
      state.toolLength = { mode: 'G43', h: value('H') ?? (state.toolLength.mode === 'G43' ? state.toolLength.h : null) }
      state.dynamicToolLength = false
      state.seen.add('toolLength')
    } else if (g === '43.1') {
      state.dynamicToolLength = true
      state.seen.add('toolLength')
    }
  }

  const unsupportedCoordinateState = gCodes.find(g => ['41.1', '43.2', '51', '52', '54.1', '68'].includes(g))
  if (unsupportedCoordinateState) {
    addUnique(blockers, `The selected line depends on unsupported modal state G${unsupportedCoordinateState}. Restart before it is enabled.`)
  }

  const unitScale = state.units === 'G20' ? 25.4 : 1
  const feed = value('F')
  if (feed != null) state.feedMmPerMin = feed * unitScale
  const speed = value('S')
  if (speed != null) state.spindleSpeed = speed
  const tool = value('T')
  if (tool != null) state.pendingTool = Math.trunc(tool)

  for (const m of mCodes) {
    if (m === 3 || m === 4 || m === 5) state.spindle = `M${m}` as 'M3' | 'M4' | 'M5'
    else if (m === 7) state.coolant.add('M7')
    else if (m === 8) state.coolant.add('M8')
    else if (m === 9) state.coolant.clear()
    else if (m === 6) {
      if (state.pendingTool != null) state.tool = state.pendingTool
      // A manual tool change sets the new tool's length offset in the controller
      // (G43.1), so an earlier G43/G49 from the program no longer applies. A
      // tool-length word on the same line runs after the change and still counts.
      if (!gCodes.some(g => g === '43' || g === '43.1' || g === '49') && !state.dynamicToolLength) {
        state.toolLength = { mode: 'G49' }
        state.seen.delete('toolLength')
      }
    }
  }
  if (state.tool == null && state.pendingTool != null) state.tool = state.pendingTool

  if (gCodes.includes('92') || gCodes.includes('92.1') || gCodes.includes('92.2') || gCodes.includes('92.3')) {
    addUnique(blockers, 'The selected line depends on G92 coordinate state, which cannot be recreated safely yet.')
    state.positionKnown = { x: false, y: false, z: false }
    return
  }
  if (gCodes.includes('10')) {
    addUnique(blockers, 'The selected line follows a G10 coordinate/tool-table change. Restart generation will not replay persistent offset changes.')
    return
  }

  const hasG53 = gCodes.includes('53')
  const hasReferenceMove = gCodes.includes('28') || gCodes.includes('30')
  if (hasReferenceMove) {
    state.positionKnown = { x: false, y: false, z: false }
    return
  }

  const axisWords = {
    x: value('X'),
    y: value('Y'),
    z: value('Z'),
  }
  const hasAxis = Object.values(axisWords).some(axis => axis != null)
  const suppressModalMotion = gCodes.some(g => ['4', '10', '53', '92', '92.1', '92.2', '92.3'].includes(g)) && !hasG53
  if (!hasAxis || suppressModalMotion) return

  if (hasG53) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (axisWords[axis] != null) state.positionKnown[axis] = false
    }
    return
  }

  for (const axis of ['x', 'y', 'z'] as const) {
    const axisValue = axisWords[axis]
    if (axisValue == null) continue
    const mm = axisValue * unitScale
    if (state.distance === 'G90') {
      state.positionMm[axis] = mm
      state.positionKnown[axis] = true
    } else if (state.positionKnown[axis]) {
      state.positionMm[axis] += mm
    }
  }
}

function validateFirstSuffixFeed(
  lines: string[],
  resumeIndex: number,
  initialMotion: RestartModalState['motion'],
  initialFeedKnown: boolean,
  blockers: string[],
) {
  let motion = initialMotion
  let feedKnown = initialFeedKnown
  for (let index = resumeIndex; index < lines.length; index++) {
    const code = stripComments(lines[index])
    if (!code) continue
    const words = wordsIn(code)
    const gCodes = words.filter(word => word.letter === 'G').map(word => codeValue(word.value))
    const explicitMotion = [...gCodes].reverse().find(g => ['0', '1', '2', '3'].includes(g))
    if (explicitMotion) motion = `G${explicitMotion}` as RestartModalState['motion']
    if (words.some(word => word.letter === 'F')) feedKnown = true

    const isNonMotionAxisBlock = gCodes.some(g => ['10', '28', '30', '53', '92', '92.1', '92.2', '92.3'].includes(g))
    const hasLinearEndpoint = words.some(word => ['X', 'Y', 'Z'].includes(word.letter))
    const hasArcDefinition = (motion === 'G2' || motion === 'G3')
      && words.some(word => ['I', 'J', 'K', 'R'].includes(word.letter))
    if (!isNonMotionAxisBlock && (hasLinearEndpoint || hasArcDefinition)) {
      if (motion !== 'G0' && !feedKnown) {
        addUnique(blockers, `The first feed move after the restart (line ${index + 1}) depends on an unknown earlier F value.`)
      }
      return
    }
  }
}

function restoreMotionOnSuffix(lines: string[], motion: RestartModalState['motion']) {
  let motionEstablished = false
  return lines.map(raw => {
    if (motionEstablished) return raw
    const code = stripComments(raw)
    if (!code) return raw

    const words = wordsIn(code)
    const gCodes = words.filter(word => word.letter === 'G').map(word => codeValue(word.value))
    if (gCodes.some(g => ['0', '1', '2', '3'].includes(g))) {
      motionEstablished = true
      return raw
    }

    const hasMotionWords = words.some(word => ['X', 'Y', 'Z', 'I', 'J', 'K', 'R'].includes(word.letter))
    const isNonMotionAxisBlock = gCodes.some(g => ['10', '28', '30', '53', '92', '92.1', '92.2', '92.3'].includes(g))
    if (!hasMotionWords || isNonMotionAxisBlock) return raw

    motionEstablished = true
    return `${motion} ${raw.trimStart()}`
  })
}

function validateRestartProgram(program: string) {
  const lines = normalizedLines(program)
  for (let index = 0; index < lines.length; index++) {
    const code = stripComments(lines[index])
    if (!code) continue
    const words = wordsIn(code)
    const hasArcMotion = words.some(word => word.letter === 'G' && (word.value === 2 || word.value === 3))
    const hasArcGeometry = words.some(word => ['X', 'Y', 'Z', 'I', 'J', 'K', 'R'].includes(word.letter))
    if (hasArcMotion && !hasArcGeometry) {
      throw new Error(`Generated restart line ${index + 1} contains an arc command without arc geometry.`)
    }
  }
}

export function analyzeRestart(text: string, requestedLine: number): RestartAnalysis {
  const scan = scanProgram(text)
  const { lines, movesZ } = scan
  const clampedRequested = Math.max(1, Math.min(Math.trunc(requestedLine), lines.length))
  let resumeIndex = clampedRequested - 1
  while (resumeIndex < lines.length && !isExecutable(lines[resumeIndex])) resumeIndex++

  const blockers = [...scan.blockers]
  const warnings: string[] = []

  if (resumeIndex >= lines.length) {
    addUnique(blockers, 'There is no executable G-code at or after the requested line.')
    resumeIndex = Math.min(clampedRequested - 1, lines.length - 1)
  }

  const prefix = prefixStateBefore(scan, resumeIndex)
  const state = prefix.state
  for (const blocker of prefix.blockers) addUnique(blockers, blocker)

  if (resumeIndex > 0) {
    for (const axis of movesZ ? ['x', 'y', 'z'] as const : ['x', 'y'] as const) {
      if (!state.positionKnown[axis]) {
        addUnique(blockers, `The ${axis.toUpperCase()} position before line ${resumeIndex + 1} cannot be determined from the program.`)
      }
    }
  }
  if (state.cutterComp !== 'G40') {
    addUnique(blockers, `Cutter compensation ${state.cutterComp} is active at the selected line. Restart before compensation is engaged.`)
  }
  if (state.cannedCycle !== 'G80') {
    addUnique(blockers, `Canned cycle ${state.cannedCycle} is active at the selected line. Restart before the cycle begins.`)
  }
  if (state.dynamicToolLength) {
    addUnique(blockers, 'Dynamic tool-length compensation G43.1 is active at the selected line.')
  }
  if (state.toolLength.mode === 'G43' && state.toolLength.h == null) {
    addUnique(blockers, 'Tool-length compensation is active, but its H register cannot be determined.')
  }
  if (state.feedMode !== 'G94') {
    addUnique(blockers, `${state.feedMode} feed mode is active. The first release supports units-per-minute G94 restarts only.`)
  }
  if (state.spindle !== 'M5' && state.spindleSpeed == null) {
    addUnique(blockers, 'The spindle is active at the selected line, but its commanded S speed cannot be determined.')
  }
  validateFirstSuffixFeed(lines, resumeIndex, state.motion, state.feedMmPerMin != null, blockers)

  const assumed: Array<[string, string]> = [
    ['units', 'Units were not commanded before this line; G21 is being assumed.'],
    ['distance', 'Distance mode was not commanded before this line; G90 is being assumed.'],
    ['plane', 'Plane was not commanded before this line; G17 is being assumed.'],
    ['wcs', 'No work offset was commanded before this line; the controller\'s active offset (G54 after a reset) is used.'],
  ]
  if (resumeIndex > 0) {
    for (const [group, message] of assumed) {
      if (!state.seen.has(group)) warnings.push(message)
    }
  }
  if (resumeIndex + 1 !== clampedRequested) {
    warnings.push(`Line ${clampedRequested} is blank or comment-only; execution will resume at line ${resumeIndex + 1}.`)
  }
  if (resumeIndex > 0 && state.spindle === 'M5') {
    warnings.push('The spindle is off at the restart point. Verify that the selected line starts it before any cutting move.')
  }
  if (resumeIndex > 0 && !movesZ) {
    warnings.push('The program never moves Z, so neither does the restart. Check the focus or Z height first.')
  }

  const contextStart = Math.max(0, resumeIndex - 2)
  const contextEnd = Math.min(lines.length, resumeIndex + 3)
  return {
    requestedLine: clampedRequested,
    resumeLine: resumeIndex + 1,
    totalLines: lines.length,
    resumeText: lines[resumeIndex] ?? '',
    context: lines.slice(contextStart, contextEnd).map((line, offset) => ({
      line: contextStart + offset + 1,
      text: line,
      resume: contextStart + offset === resumeIndex,
    })),
    state: {
      units: state.units,
      distance: state.distance,
      arcDistance: state.arcDistance,
      plane: state.plane,
      feedMode: state.feedMode,
      motion: state.motion,
      wcs: state.seen.has('wcs') ? state.wcs : null,
      cutterComp: state.cutterComp,
      cannedCycle: state.cannedCycle,
      toolLength: state.seen.has('toolLength') ? state.toolLength : null,
      tool: state.tool,
      feedMmPerMin: state.feedMmPerMin,
      spindleSpeed: state.spindleSpeed,
      spindle: state.spindle,
      coolant: [...state.coolant],
      positionMm: { ...state.positionMm },
    },
    movesZ,
    warnings,
    blockers,
  }
}

export function buildRestartProgram(text: string, analysis: RestartAnalysis, options: RestartProgramOptions) {
  if (analysis.blockers.length) throw new Error(analysis.blockers[0])
  const { lines } = scanProgram(text)
  const state = analysis.state
  const p = state.positionMm
  const toolLength = state.toolLength == null
    ? null
    : state.toolLength.mode === 'G43' ? `G43 H${state.toolLength.h}` : 'G49'
  if (analysis.resumeLine === 1) {
    return [
      '(FLUIDNC PROGRAM RESTART - REVIEW BEFORE RUNNING)',
      `(SOURCE: ${options.sourceName.replace(/[()]/g, '')})`,
      `(SOURCE PATH: ${options.sourcePath.replace(/[()]/g, '')})`,
      '(RESUME FILE LINE: 1 - COMPLETE ORIGINAL PROGRAM)',
      '(THE ORIGINAL FILE IS UNCHANGED)',
      '',
      ...lines,
      '',
    ].join('\n')
  }
  if (analysis.movesZ) {
    if (![options.safeMachineZMm, options.clearanceMm, options.approachFeedMmPerMin].every(Number.isFinite)) {
      throw new Error('Restart positioning values must be valid numbers.')
    }
    if (options.clearanceMm < 0) throw new Error('Approach clearance cannot be negative.')
    if (options.approachFeedMmPerMin <= 0) throw new Error('Approach feed must be greater than zero.')
  }
  const sourceFeed = state.feedMmPerMin == null
    ? null
    : state.units === 'G20' ? state.feedMmPerMin / 25.4 : state.feedMmPerMin
  const resumedLines = restoreMotionOnSuffix(lines.slice(analysis.resumeLine - 1), state.motion)

  const output: string[] = [
    '(FLUIDNC PROGRAM RESTART - REVIEW BEFORE RUNNING)',
    `(SOURCE: ${options.sourceName.replace(/[()]/g, '')})`,
    `(SOURCE PATH: ${options.sourcePath.replace(/[()]/g, '')})`,
    `(REQUESTED FILE LINE: ${analysis.requestedLine})`,
    `(RESUME FILE LINE: ${analysis.resumeLine})`,
    '(THE ORIGINAL FILE IS UNCHANGED)',
    '(HOME THE MACHINE AND VERIFY OFFSETS BEFORE RUNNING)',
    state.tool != null ? `(VERIFY TOOL T${state.tool} IS LOADED)` : '(VERIFY THE CORRECT TOOL IS LOADED)',
    '',
    '(SAFE RESTART POSITIONING)',
    ...(analysis.movesZ ? [] : ['(THE PROGRAM NEVER COMMANDS Z - Z IS NOT MOVED)']),
    'M5',
    'M9',
    'G21 G90 G40 G80',
    ...(analysis.movesZ ? [`G53 G0 Z${fmt(options.safeMachineZMm)}`] : []),
    state.wcs ?? '(NO WORK OFFSET IN THE PROGRAM - THE ACTIVE OFFSET IS USED)',
  ]

  if (state.tool != null) output.push(`T${state.tool}`)
  // A tool-length offset the program never set (e.g. one measured by a manual
  // tool change) belongs to the controller and is left in force.
  if (toolLength) output.push(toolLength)
  output.push(`G0 X${fmt(p.x)} Y${fmt(p.y)}`)
  if (analysis.movesZ) output.push(`G0 Z${fmt(p.z + options.clearanceMm)}`)
  if (state.spindle !== 'M5') {
    output.push(`${state.spindleSpeed != null ? `S${fmt(state.spindleSpeed, 2)} ` : ''}${state.spindle}`)
  }
  if (state.coolant.length) output.push(state.coolant.join(' '))
  if (analysis.movesZ) output.push(`G94 G1 Z${fmt(p.z)} F${fmt(options.approachFeedMmPerMin, 2)}`)
  output.push(
    '',
    '(RESTORE PROGRAM MODES)',
    `${state.units} ${state.plane} ${state.arcDistance} ${state.feedMode}`,
  )
  if (sourceFeed != null) output.push(`F${fmt(sourceFeed, 3)}`)
  output.push(
    state.distance,
    '',
    `(ORIGINAL PROGRAM RESUMES AT FILE LINE ${analysis.resumeLine})`,
  )
  // Not push(...resumedLines): a spread call fails past ~125k arguments.
  for (const line of resumedLines) output.push(line)

  const program = `${output.join('\n')}\n`
  validateRestartProgram(program)
  return program
}

export function makeRestartFilename(sourceName: string, line: number) {
  const dot = sourceName.lastIndexOf('.')
  const stem = (dot > 0 ? sourceName.slice(0, dot) : sourceName).replace(/\.restart-L\d+$/i, '')
  const extension = dot > 0 ? sourceName.slice(dot) : '.nc'
  return `${stem}.restart-L${line}${extension}`
}
