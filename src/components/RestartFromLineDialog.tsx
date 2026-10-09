import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, FileCode2, ShieldCheck, X } from 'lucide-react'
import { analyzeRestart, buildRestartProgram, makeRestartFilename } from '../lib/gcodeRestart'
import { saveFileContent } from '../lib/http'
import { controllerFilesystem } from '../lib/controllerFiles'
import { useGCodeStore } from '../store/gcode'
import { useMachineStore } from '../store'
import { displayToMm, feedUnitLabel, linearUnitLabel, mmToDisplay } from '../lib/units'
import type { Units } from '../types'

interface Props {
  sourceText: string
  sourcePath: string | null
  sourceName: string
  initialLine?: number | null
  defaultSafeMachineZMm: number | null
  onPrepared?: () => void
  onClose: () => void
}

const PROGRAM_LINE_HEIGHT = 20
const PROGRAM_PADDING_Y = 12

function splitPath(path: string) {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return { directory: '/', filename: path }
  return {
    directory: path.slice(0, slash + 1) || '/',
    filename: path.slice(slash + 1),
  }
}

function fmtLinear(mmValue: number | null, units: Units) {
  if (mmValue == null || !Number.isFinite(mmValue)) return '—'
  const display = mmToDisplay(mmValue, units)
  return String(Number(display.toFixed(units === 'in' ? 4 : 3)))
}

function defaultClearanceText(units: Units) {
  return units === 'in' ? '0.1' : '2'
}

function defaultApproachFeedText(units: Units) {
  return units === 'in' ? '4' : '100'
}

function safeZTextFromMm(mmValue: number | null, units: Units) {
  if (mmValue == null || !Number.isFinite(mmValue)) return ''
  return String(Number(mmToDisplay(mmValue, units).toFixed(units === 'in' ? 4 : 3)))
}

function numericInput(value: string) {
  return value.trim() === '' ? Number.NaN : Number(value)
}

export function RestartFromLineDialog({
  sourceText,
  sourcePath,
  sourceName,
  initialLine = null,
  defaultSafeMachineZMm,
  onPrepared,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const programRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const lineHighlightRef = useRef<HTMLDivElement>(null)
  const loadFromText = useGCodeStore(s => s.loadFromText)
  const units = useMachineStore(s => s.units)
  const program = useMemo(() => {
    const text = sourceText.replace(/\r\n?/g, '\n')
    const starts = [0]
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\n' && index < text.length - 1) starts.push(index + 1)
    }
    return {
      text,
      lineStarts: starts,
      lineNumbers: starts.map((_, index) => String(index + 1)).join('\n'),
    }
  }, [sourceText])
  const totalLines = program.lineStarts.length
  const initialSelectedLine = initialLine == null
    ? null
    : Math.max(1, Math.min(Math.trunc(initialLine), totalLines))
  const [lineText, setLineText] = useState(initialSelectedLine == null ? '' : String(initialSelectedLine))
  const [selectedLine, setSelectedLine] = useState<number | null>(initialSelectedLine)
  const [analyzedLine, setAnalyzedLine] = useState<number | null>(initialSelectedLine)
  const [safeZText, setSafeZText] = useState(() => safeZTextFromMm(defaultSafeMachineZMm, units))
  const [clearanceText, setClearanceText] = useState(() => defaultClearanceText(units))
  const [approachFeedText, setApproachFeedText] = useState(() => defaultApproachFeedText(units))
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (initialSelectedLine != null) selectProgramLine(initialSelectedLine, true)
    else inputRef.current?.focus()
    // The dialog is remounted for each restart review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestedLine = Number(lineText)
  const lineIsValid = Number.isInteger(requestedLine) && requestedLine >= 1 && requestedLine <= totalLines
  const analysis = useMemo(
    () => analyzedLine == null ? null : analyzeRestart(sourceText, analyzedLine),
    [analyzedLine, sourceText],
  )
  const generatedName = analysis ? makeRestartFilename(sourceName, analysis.resumeLine) : ''
  const safeZ = numericInput(safeZText)
  const clearance = numericInput(clearanceText)
  const approachFeed = numericInput(approachFeedText)
  const positioningValid = analysis?.resumeLine === 1 || (Number.isFinite(safeZ)
    && Number.isFinite(clearance) && clearance >= 0
    && Number.isFinite(approachFeed) && approachFeed > 0)
  const canPrepare = !!analysis && analysis.blockers.length === 0 && positioningValid && !preparing

  function updateLineHighlight(line: number | null, scrollTop = programRef.current?.scrollTop ?? 0) {
    const highlight = lineHighlightRef.current
    if (!highlight || line == null) return
    highlight.style.display = 'block'
    highlight.style.transform = `translateY(${PROGRAM_PADDING_Y + (line - 1) * PROGRAM_LINE_HEIGHT - scrollTop}px)`
  }

  function lineAtOffset(offset: number) {
    let low = 0
    let high = program.lineStarts.length - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (program.lineStarts[middle] <= offset) low = middle + 1
      else high = middle - 1
    }
    return Math.max(1, high + 1)
  }

  function selectProgramLine(line: number, center = false) {
    const selected = Math.max(1, Math.min(Math.trunc(line), totalLines))
    const textarea = programRef.current
    setLineText(String(selected))
    setSelectedLine(selected)
    setAnalyzedLine(selected)
    setError('')
    if (!textarea) return

    const start = program.lineStarts[selected - 1]
    const end = selected < totalLines ? Math.max(start, program.lineStarts[selected] - 1) : program.text.length
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(start, end)
    if (center) {
      textarea.scrollTop = Math.max(0, (selected - 1) * PROGRAM_LINE_HEIGHT - textarea.clientHeight / 2 + PROGRAM_LINE_HEIGHT / 2)
      if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop
    }
    updateLineHighlight(selected, textarea.scrollTop)
  }

  function reviewLine() {
    if (!lineIsValid) return
    selectProgramLine(requestedLine, true)
  }

  async function prepare() {
    if (!analysis || !canPrepare) return
    setPreparing(true)
    setError('')
    try {
      const generated = buildRestartProgram(sourceText, analysis, {
        sourceName,
        sourcePath: sourcePath ?? `local:${sourceName}`,
        safeMachineZMm: displayToMm(safeZ, units),
        clearanceMm: displayToMm(clearance, units),
        approachFeedMmPerMin: displayToMm(approachFeed, units),
      })
      const restartMetadata = {
        path: sourcePath,
        fileName: sourceName,
        sourceText: sourcePath ? undefined : sourceText,
        requestedLine: analysis.requestedLine,
        resumeLine: analysis.resumeLine,
      }
      if (sourcePath == null) {
        await loadFromText(generated, generatedName, null, restartMetadata)
      } else {
        const { directory } = splitPath(sourcePath)
        const generatedPath = `${directory}${generatedName}`
        await saveFileContent(directory, generatedName, generated, controllerFilesystem(sourcePath))
        window.dispatchEvent(new Event('files:changed'))
        await loadFromText(generated, generatedName, generatedPath, restartMetadata)
      }
      const prepared = useGCodeStore.getState()
      if (prepared.fileName !== generatedName
        || prepared.restartSource?.requestedLine !== analysis.requestedLine
        || prepared.restartSource?.resumeLine !== analysis.resumeLine) {
        throw new Error('The restart program could not be loaded in the viewer.')
      }
      onPrepared?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare the restart file.')
    } finally {
      setPreparing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-3 sm:p-6" onClick={() => { if (!preparing) onClose() }}>
      <div
        className="w-full max-w-5xl h-[92vh] max-h-[920px] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl flex flex-col animate-in"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-text-primary font-semibold text-lg">
              <FileCode2 size={18} className="text-accent" />
              Restart from line
            </div>
            <p className="mt-1 text-sm text-text-muted truncate">
              {sourceName} · {totalLines.toLocaleString()} file lines
            </p>
          </div>
          <button className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated disabled:opacity-50" onClick={onClose} title="Close" disabled={preparing}>
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 sm:px-5 flex flex-col gap-4">
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-1.5" htmlFor="restart-line-number">
              Selected file line
            </label>
            <div className="flex items-stretch rounded border border-border bg-elevated overflow-hidden focus-within:border-accent/70">
              <span className="flex items-center px-3 border-r border-border font-mono text-text-dim">L</span>
              <input
                ref={inputRef}
                id="restart-line-number"
                type="number"
                min={1}
                max={totalLines}
                step={1}
                value={lineText}
                onChange={event => { setLineText(event.target.value); setSelectedLine(null); setAnalyzedLine(null); setError('') }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    reviewLine()
                  }
                }}
                placeholder={`1–${totalLines}`}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-xl text-text-primary outline-none"
              />
              <button
                className="px-4 border-l border-border text-sm font-semibold text-accent hover:bg-accent/10 disabled:text-text-dim disabled:hover:bg-transparent"
                onClick={reviewLine}
                disabled={!lineIsValid}
              >
                Go
              </button>
            </div>
            {lineText && !lineIsValid && (
              <p className="mt-1.5 text-sm text-danger">Enter a whole number from 1 through {totalLines}.</p>
            )}
            {initialSelectedLine != null && (
              <p className="mt-1.5 text-sm text-warn">
                Suggested from the last tracked machine position. Confirm the actual stop point and selected program line before preparing a restart.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <span className="text-sm font-semibold text-text-primary">Program</span>
              <span className="text-xs text-text-muted">Click any line to select it</span>
            </div>
            <div className="relative h-[42vh] min-h-[260px] overflow-hidden rounded border border-border bg-surface font-mono text-[13px]">
              <div
                ref={lineHighlightRef}
                className="absolute left-0 right-0 h-5 bg-accent/10 border-l-2 border-accent pointer-events-none z-0"
                style={{ display: selectedLine == null ? 'none' : 'block' }}
              />
              <div ref={gutterRef} className="absolute inset-y-0 left-0 w-16 overflow-hidden border-r border-border bg-elevated z-10 select-none" aria-hidden="true">
                <pre className="m-0 py-3 pr-3 text-right text-text-dim" style={{ lineHeight: `${PROGRAM_LINE_HEIGHT}px` }}>{program.lineNumbers}</pre>
              </div>
              <textarea
                ref={programRef}
                readOnly
                wrap="off"
                spellCheck={false}
                value={program.text}
                aria-label="Complete G-code program. Click a line to select it for restart."
                className="absolute inset-y-0 left-16 right-0 w-auto resize-none overflow-auto border-0 bg-transparent py-3 px-3 text-text-primary outline-none z-10 selection:bg-accent/30"
                style={{ lineHeight: `${PROGRAM_LINE_HEIGHT}px`, tabSize: 2 }}
                onScroll={event => {
                  const scrollTop = event.currentTarget.scrollTop
                  if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
                  updateLineHighlight(selectedLine, scrollTop)
                }}
                onClick={event => selectProgramLine(lineAtOffset(event.currentTarget.selectionStart))}
                onKeyUp={event => {
                  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
                    selectProgramLine(lineAtOffset(event.currentTarget.selectionStart))
                  }
                }}
              />
            </div>
          </div>

          {analysis && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SummaryCell label="Resume line" value={`L${analysis.resumeLine}`} accent />
                <SummaryCell label="Work offset" value={analysis.state.wcs} />
                <SummaryCell label="Tool" value={analysis.state.tool == null ? 'Verify' : `T${analysis.state.tool}`} />
                <SummaryCell
                  label={`Start position (${linearUnitLabel(units)})`}
                  value={`X${fmtLinear(analysis.state.positionMm.x, units)} Y${fmtLinear(analysis.state.positionMm.y, units)} Z${fmtLinear(analysis.state.positionMm.z, units)}`}
                  compact
                />
              </div>

              {analysis.blockers.length > 0 && (
                <div className="rounded border border-danger/40 bg-danger/10 px-3.5 py-3">
                  <div className="flex items-center gap-2 text-danger font-semibold text-sm mb-1.5">
                    <AlertTriangle size={15} /> Cannot prepare this restart
                  </div>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-text-primary">
                    {analysis.blockers.map(message => <li key={message}>{message}</li>)}
                  </ul>
                </div>
              )}

              {analysis.warnings.length > 0 && analysis.blockers.length === 0 && (
                <div className="rounded border border-warn/35 bg-warn/10 px-3.5 py-3">
                  <div className="flex items-center gap-2 text-warn font-semibold text-sm mb-1.5">
                    <AlertTriangle size={15} /> Review before running
                  </div>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-text-primary">
                    {analysis.warnings.map(message => <li key={message}>{message}</li>)}
                  </ul>
                </div>
              )}

              {analysis.blockers.length === 0 && analysis.resumeLine > 1 && (
                <details className="rounded border border-border bg-elevated/40 group">
                  <summary className="cursor-pointer select-none px-3.5 py-2.5 text-sm font-semibold text-text-primary">
                    Safe positioning
                    <span className="ml-2 font-normal text-text-muted">G53 retract and controlled Z re-entry</span>
                  </summary>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-3.5 pb-3.5 border-t border-border pt-3">
                    <NumberField label="Machine safe Z" value={safeZText} onChange={setSafeZText} suffix={linearUnitLabel(units)} />
                    <NumberField label="Approach clearance" value={clearanceText} onChange={setClearanceText} suffix={linearUnitLabel(units)} min="0" />
                    <NumberField label="Approach feed" value={approachFeedText} onChange={setApproachFeedText} suffix={feedUnitLabel(units)} min="0.001" />
                  </div>
                  {!positioningValid && <p className="px-3.5 pb-3 text-sm text-danger">Enter valid safe-positioning values.</p>}
                </details>
              )}

              <div className="flex items-center gap-2 rounded border border-ok/25 bg-ok/5 px-3.5 py-3 text-sm">
                <ShieldCheck size={17} className="text-ok shrink-0" />
                <span className="text-text-muted">
                  {sourcePath && (
                    <>Preparing saves <span className="font-mono text-text-primary">{generatedName}</span> beside the original controller file and loads it in the viewer.</>
                  )}{' '}Verify the tool and offsets before running.
                </span>
              </div>
            </>
          )}

          {error && <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-danger">{error}</div>}
        </div>

        <div className="border-t border-border px-4 py-3 sm:px-5 flex items-center justify-end gap-2 bg-elevated/30">
          <button className="btn btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={preparing}>Cancel</button>
          <button className="btn btn-primary px-4 py-2 text-sm gap-2" onClick={prepare} disabled={!canPrepare}>
            {preparing ? 'Preparing…' : <><span>Prepare in viewer</span><ArrowRight size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryCell({ label, value, accent, compact }: { label: string; value: string; accent?: boolean; compact?: boolean }) {
  return (
    <div className="rounded border border-border bg-elevated/60 px-2.5 py-2 min-w-0">
      <div className="text-xs uppercase tracking-wide text-text-dim mb-0.5">{label}</div>
      <div className={`font-mono font-semibold truncate ${compact ? 'text-xs' : 'text-sm'} ${accent ? 'text-accent' : 'text-text-primary'}`} title={value}>{value}</div>
    </div>
  )
}

function NumberField({ label, value, onChange, suffix, min }: {
  label: string
  value: string
  onChange: (value: string) => void
  suffix: string
  min?: string
}) {
  return (
    <label className="text-xs text-text-muted">
      <span className="block mb-1">{label}</span>
      <span className="flex items-center rounded border border-border bg-surface focus-within:border-accent/60">
        <input
          type="number"
          step="any"
          min={min}
          value={value}
          onChange={event => onChange(event.target.value)}
          className="w-full min-w-0 bg-transparent px-2 py-1.5 font-mono text-sm text-text-primary outline-none"
        />
        <span className="pr-2 text-[11px] text-text-dim whitespace-nowrap">{suffix}</span>
      </span>
    </label>
  )
}
