import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, FileCode2, Info, Navigation, Target, Wrench } from '../icons'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { ProbePanel } from './ProbePanel'
import { ManualATCPanel } from './ManualATCPanel'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { useSingleBlockStore } from '../store/singleBlock'
import { pendingBlockMatchesSource } from '../lib/singleBlock'
import { controllerPathsMatch } from '../lib/controllerFiles'

const LINE_HEIGHT = 20
const PADDING_Y = 10

function basename(path: string | null | undefined) {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function stripComments(raw: string) {
  let result = ''
  let depth = 0
  for (const char of raw) {
    if (char === ';' && depth === 0) break
    if (char === '(') { depth++; continue }
    if (char === ')' && depth > 0) { depth--; continue }
    if (depth === 0) result += char
  }
  return result
}

function plannerNumber(raw: string) {
  const match = stripComments(raw).match(/^\s*\/?\s*N\s*(\d+)/i)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

/** Programs longer than this are shown as a virtual list instead of one textarea. */
const VIRTUAL_PROGRAM_LINES = 20_000
/** Browsers cap element heights (about 33M px in Chrome), so very long programs scroll a shorter element. */
const MAX_SCROLL_HEIGHT_PX = 8_000_000
const OVERSCAN_LINES = 12
const CH_UPPER_N = 78
const CH_LOWER_N = 110

interface Program {
  text: string
  totalLines: number
  /** Offset of each line in `text`. */
  lineStarts: number[]
  /** Gutter text for the textarea view; empty for virtual programs. */
  lineNumbers: string
  nToPhysicalLine: Map<number, number>
  virtual: boolean
}

function lineText(program: Program, index: number) {
  const start = program.lineStarts[index]
  let end = index + 1 < program.lineStarts.length ? program.lineStarts[index + 1] - 1 : program.text.length
  // The last line may still end with the file's trailing newline.
  if (end > start && program.text.charCodeAt(end - 1) === 10) end--
  return program.text.slice(start, end)
}

function buildProgram(text: string): Program {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lineStarts = [0]
  for (let index = normalized.indexOf('\n'); index >= 0; index = normalized.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1)
  }
  // A trailing newline does not start another line.
  if (lineStarts.length > 1 && lineStarts[lineStarts.length - 1] === normalized.length) lineStarts.pop()
  const totalLines = Math.max(1, lineStarts.length)
  const program: Program = {
    text: normalized,
    totalLines,
    lineStarts,
    lineNumbers: '',
    nToPhysicalLine: new Map(),
    virtual: totalLines > VIRTUAL_PROGRAM_LINES,
  }
  for (let index = 0; index < lineStarts.length; index++) {
    // Only lines containing an N can carry a block number; skip the rest
    // without building strings for millions of lines.
    const start = lineStarts[index]
    const end = index + 1 < lineStarts.length ? lineStarts[index + 1] : normalized.length
    let hasN = false
    for (let position = start; position < end; position++) {
      const code = normalized.charCodeAt(position)
      if (code === CH_UPPER_N || code === CH_LOWER_N) {
        hasN = true
        break
      }
    }
    if (!hasN) continue
    const n = plannerNumber(lineText(program, index))
    if (n != null && !program.nToPhysicalLine.has(n)) program.nToPhysicalLine.set(n, index + 1)
  }
  if (!program.virtual) {
    program.lineNumbers = Array.from({ length: totalLines }, (_, index) => String(index + 1)).join('\n')
  }
  return program
}

/** Renders only the visible lines so multi-million-line programs stay responsive. */
function VirtualProgramView({ program, physicalLine, isEstimated, isPending, follow }: {
  program: Program
  physicalLine: number | null
  isEstimated: boolean
  isPending: boolean
  follow: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const contentHeight = program.totalLines * LINE_HEIGHT + PADDING_Y * 2
  const scrollHeight = Math.min(contentHeight, MAX_SCROLL_HEIGHT_PX)
  const scale = scrollHeight > viewportHeight ? (contentHeight - viewportHeight) / (scrollHeight - viewportHeight) : 1
  const offset = scrollTop * scale

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setViewportHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !follow || physicalLine == null) return
    const target = Math.max(0, PADDING_Y + (physicalLine - 1) * LINE_HEIGHT - element.clientHeight / 2 + LINE_HEIGHT / 2)
    element.scrollTop = target / scale
    // The scroll event only arrives with the next frame; render the new rows now.
    setScrollTop(element.scrollTop)
  }, [physicalLine, follow, scale])

  const first = Math.max(0, Math.floor((offset - PADDING_Y) / LINE_HEIGHT) - OVERSCAN_LINES)
  const last = Math.min(program.totalLines - 1, Math.ceil((offset + viewportHeight) / LINE_HEIGHT) + OVERSCAN_LINES)
  const rows = []
  for (let index = first; index <= last; index++) {
    const highlighted = physicalLine === index + 1
    rows.push(
      <div
        key={index}
        className={`absolute left-0 flex min-w-full ${highlighted ? (isPending ? 'bg-warn/15' : isEstimated ? 'bg-info/15' : 'bg-ok/15') : ''}`}
        style={{ top: scrollTop + PADDING_Y + index * LINE_HEIGHT - offset, height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
      >
        <span className={`sticky left-0 w-16 shrink-0 pr-3 text-right border-r select-none ${highlighted ? (isPending ? 'border-l-2 border-l-warn border-r-border bg-warn/15 text-warn' : isEstimated ? 'border-l-2 border-l-info border-r-border bg-info/15 text-info' : 'border-l-2 border-l-ok border-r-border bg-ok/15 text-ok') : 'border-border bg-elevated text-text-dim'}`} aria-hidden="true">
          {index + 1}
        </span>
        <span className="whitespace-pre px-3 text-text-primary" style={{ tabSize: 2 }}>{lineText(program, index)}</span>
      </div>,
    )
  }

  return (
    <div
      ref={scrollRef}
      className="absolute inset-0 overflow-auto z-10 selection:bg-info/25"
      role="log"
      aria-label="Running G-code program"
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: scrollHeight }}>
        {rows}
      </div>
    </div>
  )
}

export function ProgramExecutionPanel({ isTablet, initiallyOpen = false, accordionManaged = false }: { isTablet?: boolean; initiallyOpen?: boolean; accordionManaged?: boolean }) {
  const status = useMachineStore(s => s.status)
  const sourceText = useGCodeStore(s => s.sourceText)
  const fileName = useGCodeStore(s => s.fileName)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const viewerSourceLine = useGCodeStore(s => s.activeSourceLine)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderAcceptedLine = useGCodeSenderStore(s => s.acceptedLine)
  const senderFailureLine = useGCodeSenderStore(s => s.failureLine)
  const senderFailureLineSource = useGCodeSenderStore(s => s.failureLineSource)
  const pendingBlock = useSingleBlockStore(s => s.pendingBlock)
  const blockReady = useSingleBlockStore(s => s.ready)
  const programRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(initiallyOpen)
  const contentOpen = accordionManaged || open
  const [follow, setFollow] = useState(true)
  const [showTrackingInfo, setShowTrackingInfo] = useState(false)

  const pendingStep = blockReady && status.state === 'Hold' ? pendingBlock : null
  const runningPath = pendingStep?.path ?? status.sdFilename
  const runningName = basename(runningPath)
  const loadedName = basename(loadedPath) || fileName || ''
  const sourceMatchesJob = !!sourceText && (
    pendingStep
      ? pendingBlockMatchesSource(pendingStep, loadedPath)
      : !runningPath || (loadedPath
        ? controllerPathsMatch(runningPath, loadedPath)
        : runningName.toLowerCase() === loadedName.toLowerCase())
  )
  const program = useMemo(() => buildProgram(sourceMatchesJob ? sourceText! : ''), [sourceMatchesJob, sourceText])
  const reportedN = status.plannerLineNumber
  const senderActive = senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
  const senderMode = senderPhase !== 'idle'
  const controllerPhysicalLine = reportedN == null ? null : program.nToPhysicalLine.get(reportedN) ?? null
  const pendingPhysicalLine = pendingStep && sourceMatchesJob && pendingStep.line <= program.totalLines
    ? pendingStep.line : null
  const estimatedPhysicalLine = sourceMatchesJob
    && viewerSourceLine != null
    && viewerSourceLine >= 1
    && viewerSourceLine <= program.totalLines
    ? viewerSourceLine
    : null
  const retainedFailureLine = senderMode && !senderActive && senderFailureLineSource === 'position'
    ? senderFailureLine
    : null
  const physicalLine = pendingStep ? pendingPhysicalLine : retainedFailureLine ?? controllerPhysicalLine ?? estimatedPhysicalLine
  const isEstimated = !pendingStep && (retainedFailureLine != null || (controllerPhysicalLine == null && estimatedPhysicalLine != null))

  function updateHighlight(scrollTop = programRef.current?.scrollTop ?? 0) {
    const highlight = highlightRef.current
    if (!highlight) return
    if (physicalLine == null) {
      highlight.style.display = 'none'
      return
    }
    highlight.style.display = 'block'
    highlight.style.transform = `translateY(${PADDING_Y + (physicalLine - 1) * LINE_HEIGHT - scrollTop}px)`
  }

  useEffect(() => {
    const editor = programRef.current
    if (!editor || physicalLine == null) {
      updateHighlight()
      return
    }
    if (follow) {
      editor.scrollTop = Math.max(0, (physicalLine - 1) * LINE_HEIGHT - editor.clientHeight / 2 + LINE_HEIGHT / 2)
      if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop
    }
    updateHighlight(editor.scrollTop)
  }, [physicalLine, follow, contentOpen, program])

  const trackingMessage = !sourceMatchesJob
    ? runningName
      ? `The running file ${runningName} is not loaded in the viewer.`
      : 'Program source is unavailable because this job was started without loading its preview.'
    : pendingStep && pendingPhysicalLine == null
      ? `FluidNC is waiting at file line ${pendingStep.line}, which is outside the loaded source.`
    : reportedN != null && controllerPhysicalLine == null && estimatedPhysicalLine == null && !pendingStep
        ? `FluidNC reports N${reportedN}, but that block is not present in the loaded file.`
        : physicalLine == null
          ? senderActive && senderAcceptedLine != null
            ? `FluidNC has accepted through file line ${senderAcceptedLine}; waiting to locate the executing motion from live XYZ.`
            : 'Waiting for the viewer to locate the tool on the loaded toolpath.'
          : null

  return (
    <div className={`${accordionManaged ? 'flex-1 min-h-0' : 'panel shrink-0'} flex flex-col overflow-hidden ${contentOpen && !accordionManaged ? (isTablet ? 'h-[360px]' : 'h-[280px]') : ''}`}>
      {!accordionManaged && <div className="panel-header justify-between shrink-0">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(value => !value)}
          aria-expanded={contentOpen}
        >
          <FileCode2 size={isTablet ? 20 : 15} className="text-accent shrink-0" />
          <span className={`${isTablet ? 'text-xl' : 'text-lg'} font-semibold shrink-0`}>Program Execution</span>
          <ChevronDown size={isTablet ? 20 : 15} className={`ml-auto shrink-0 transition-transform duration-200 ${contentOpen ? 'rotate-180' : ''}`} />
        </button>
        {contentOpen && <div className="ml-2 flex items-center gap-2 shrink-0">
          <div className="relative">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-dim transition-colors hover:bg-elevated hover:text-info"
              onClick={() => setShowTrackingInfo(value => !value)}
              aria-label={senderMode ? 'About local sender line tracking' : 'About program line tracking'}
              aria-expanded={showTrackingInfo}
            >
              <Info size={14} />
            </button>
            {showTrackingInfo && (
              <div role="note" className="absolute right-0 top-9 z-50 w-72 rounded border border-border bg-surface p-3 text-xs font-normal normal-case tracking-normal text-text-muted shadow-xl">
                <p className="font-semibold text-text-primary">
                  {senderMode ? 'Local job line tracking' : 'About line tracking'}
                </p>
                {senderMode ? (
                  <p className="mt-1.5">
                    This is an approximation of the current line being executed. It may differ slightly due to FluidNC's planner queue.
                  </p>
                ) : (
                  <>
                    <p className="mt-1.5">
                      When FluidNC reports an N block, that value is mapped directly to the loaded controller file. Otherwise, FigUI estimates the nearest motion line from live XYZ position.
                    </p>
                    <p className="mt-1.5">
                      In single block mode, the amber highlight marks the next file line reported by FluidNC. That line has not executed yet.
                    </p>
                    <p className="mt-1.5">
                      The estimate cannot identify non-motion commands such as dwells, pauses, tool changes, spindle commands, or modal-only lines because they do not change the reported coordinates. Treat it as a visual aid, not an exact execution or restart position.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          {pendingStep ? (
            <span className="tag border-warn/35 bg-warn/10 text-warn normal-case font-mono tracking-normal">
              Next · Line {pendingStep.line}
            </span>
          ) : senderMode ? (
            physicalLine != null ? (
              <span className={`tag normal-case font-mono tracking-normal ${isEstimated ? 'border-info/35 bg-info/10 text-info' : 'border-ok/35 bg-ok/10 text-ok'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isEstimated ? 'bg-info' : 'bg-ok'} ${senderActive ? 'animate-pulse' : ''}`} />
                Line {physicalLine}
              </span>
            ) : (
              <span className="text-xs font-mono text-text-dim">Locating…</span>
            )
          ) : controllerPhysicalLine != null && reportedN != null ? (
            <span className="tag border-ok/35 bg-ok/10 text-ok normal-case font-mono tracking-normal">
              <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
              N{reportedN}
            </span>
          ) : isEstimated ? (
            <span className="tag border-info/35 bg-info/10 text-info normal-case font-mono tracking-normal" title="Nearest motion line estimated from the viewer's live XYZ toolpath tracker">
              ≈ Motion line {physicalLine}
            </span>
          ) : (
            <span className="text-xs font-mono text-text-dim">Locating…</span>
          )}
          {!pendingStep && !senderMode && controllerPhysicalLine != null && (
            <span className="text-xs font-mono text-text-muted">File line {physicalLine}</span>
          )}
          <button
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${follow ? 'text-info bg-info/10' : 'text-text-dim hover:text-text-primary bg-elevated'}`}
            onClick={() => setFollow(value => !value)}
            title={follow ? 'Disable automatic line following' : 'Follow the current program line'}
          >
            <Navigation size={12} /> Follow
          </button>
        </div>}
      </div>}

      {contentOpen && (sourceMatchesJob ? (
        <div className="relative flex-1 min-h-0 overflow-hidden bg-surface font-mono text-[13px]">
          {program.virtual ? (
            <VirtualProgramView program={program} physicalLine={physicalLine} isEstimated={isEstimated} isPending={!!pendingStep} follow={follow} />
          ) : <>
            <div
              ref={highlightRef}
              className={`absolute left-0 right-0 h-5 pointer-events-none z-20 ${pendingStep ? 'bg-warn/15 border-l-2 border-warn' : isEstimated ? 'bg-info/15 border-l-2 border-info' : 'bg-ok/15 border-l-2 border-ok'}`}
              style={{ display: physicalLine == null ? 'none' : 'block' }}
            />
            <div ref={gutterRef} className="absolute inset-y-0 left-0 w-16 overflow-hidden border-r border-border bg-elevated z-10 select-none" aria-hidden="true">
              <pre className="m-0 pr-3 text-right text-text-dim" style={{ paddingTop: PADDING_Y, paddingBottom: PADDING_Y, lineHeight: `${LINE_HEIGHT}px` }}>{program.lineNumbers}</pre>
            </div>
            <textarea
              ref={programRef}
              readOnly
              wrap="off"
              spellCheck={false}
              value={program.text}
              aria-label="Running G-code program"
              className="absolute inset-y-0 left-16 right-0 w-auto resize-none overflow-auto border-0 bg-transparent px-3 text-text-primary outline-none z-10 selection:bg-info/25"
              style={{ paddingTop: PADDING_Y, paddingBottom: PADDING_Y, lineHeight: `${LINE_HEIGHT}px`, tabSize: 2 }}
              onScroll={event => {
                const scrollTop = event.currentTarget.scrollTop
                if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
                updateHighlight(scrollTop)
              }}
            />
          </>}
          {trackingMessage && (
            <div className="absolute left-20 right-4 bottom-3 z-30 flex items-center gap-2 rounded border border-warn bg-surface px-3 py-2 text-xs text-warn shadow-lg pointer-events-none">
              <AlertTriangle size={13} className="shrink-0" />
              <span>{trackingMessage}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center p-5 bg-elevated/30">
          <div className="max-w-md text-center">
            <FileCode2 size={24} className="mx-auto mb-2 text-text-dim" />
            <p className={`${isTablet ? 'text-lg' : 'text-sm'} text-text-muted`}>{trackingMessage}</p>
            {pendingStep ? <p className="mt-2 font-mono text-warn">Next · Line {pendingStep.line}: {pendingStep.preview}</p>
              : reportedN != null && <p className="mt-2 font-mono text-ok">FluidNC executing N{reportedN}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Occupies the normal probing slot with live program tracking during a job. */
export function ProbeOrProgramPanel({ isTablet }: { isTablet?: boolean }) {
  const status = useMachineStore(s => s.status)
  const pendingBlock = useSingleBlockStore(s => s.pendingBlock)
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const hasProbingInput = Boolean(reportedHasProbe || reportedHasToolsetter)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderActive = senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
  const isProgramRunning = (status.state === 'Run' || status.state === 'Hold')
    && (!!status.sdFilename || status.plannerLineNumber != null || !!pendingBlock)
  if (isProgramRunning || senderActive) return <ProgramExecutionPanel isTablet={isTablet} />
  return <ProbeAndManualATCPanel
    isTablet={isTablet}
    hasProbingInput={hasProbingInput}
    hasManualATC={hasManualATC}
  />
}

function ProbeAndManualATCPanel({
  isTablet,
  hasProbingInput,
  hasManualATC,
}: {
  isTablet?: boolean
  hasProbingInput: boolean
  hasManualATC: boolean
}) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'probing' | 'manual-atc'>(
    hasProbingInput ? 'probing' : 'manual-atc',
  )

  useEffect(() => {
    if (activeTab === 'probing' && !hasProbingInput && hasManualATC) setActiveTab('manual-atc')
    if (activeTab === 'manual-atc' && !hasManualATC && hasProbingInput) setActiveTab('probing')
  }, [activeTab, hasProbingInput, hasManualATC])

  if (!hasProbingInput && !hasManualATC) return null

  return <div className="panel">
    <div className="panel-header flex items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Machine tools">
        {hasProbingInput && <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'probing'}
          className={`flex items-center gap-2 rounded px-2 py-1 text-lg font-semibold transition-colors ${open && activeTab === 'probing' ? 'bg-elevated text-text-primary' : 'text-text-muted hover:bg-elevated/50 hover:text-text-primary'}`}
          onClick={() => {
            setActiveTab('probing')
            setOpen(true)
          }}
        >
          <Target size={isTablet ? 20 : 15} />
          <span>Probing</span>
        </button>}
        {hasManualATC && <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'manual-atc'}
          className={`flex items-center gap-2 rounded px-2 py-1 text-lg font-semibold transition-colors ${open && activeTab === 'manual-atc' ? 'bg-elevated text-text-primary' : 'text-text-muted hover:bg-elevated/50 hover:text-text-primary'}`}
          onClick={() => {
            setActiveTab('manual-atc')
            setOpen(true)
          }}
        >
          <Wrench size={isTablet ? 20 : 15} />
          <span>Manual ATC</span>
        </button>}
      </div>
      <button
        type="button"
        className="flex shrink-0 items-center rounded p-1 hover:bg-elevated/50"
        onClick={() => setOpen(value => !value)}
        aria-label={open ? 'Collapse tools' : 'Expand tools'}
        aria-expanded={open}
      >
        <ChevronDown size={isTablet ? 20 : 15} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
    {open && (activeTab === 'probing'
      ? <ProbePanel isTablet={isTablet} embedded />
      : <ManualATCPanel isTablet={isTablet} embedded />)}
  </div>
}
