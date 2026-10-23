import { useEffect, useRef } from 'react'
import { Pause, Play, Square, X } from 'lucide-react'
import { linearUnitLabel, mmToDisplay } from '../lib/units'
import type { Units } from '../types'

export type ParallelProbeAxis = 'X' | 'Y' | 'Z'
export type ParallelStepAxis = 'X' | 'Y'

export interface ParallelPoint {
  index: number
  // Machine coordinate along the step axis at the hit (mm)
  stepPos: number
  // Machine coordinate along the probe axis at the hit (mm)
  value: number
  // True once the slow (precision) pass has been recorded
  final: boolean
}

export interface ParallelRun {
  probeAxis: ParallelProbeAxis
  stepAxis: ParallelStepAxis
  // Probe direction along the probe axis ('negative' locks for Z)
  side: 'negative' | 'positive'
  npts: number
  stepMm: number
  points: ParallelPoint[]
  failed: boolean
  done: boolean
}

interface Props {
  run: ParallelRun
  units: Units
  active: boolean
  held: boolean
  onHold: () => void
  onResume: () => void
  onAbort: () => void
  onClose: () => void
}

export function ParallelResultsModal({ run, units, active, held, onHold, onResume, onAbort, onClose }: Props) {
  const unitLabel = linearUnitLabel(units)
  const decimals = units === 'in' ? 4 : 3

  const finalCount = run.points.filter(p => p.final).length
  const complete = run.done
  const failed = run.failed

  const baseline = run.points.length > 0 ? run.points[0].value : 0
  let maxDev = 0
  for (const p of run.points) {
    if (Math.abs(p.value - baseline) > Math.abs(maxDev)) maxDev = p.value - baseline
  }

  function fmt(mm: number) {
    return mmToDisplay(mm, units).toFixed(decimals)
  }

  const closable = !active || complete || failed

  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Focus the dialog on open and restore focus to the invoking element on close.
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      restoreFocusRef.current?.focus()
    }
  }, [])

  // Escape closes only when the run is idle/complete/failed.
  useEffect(() => {
    if (!closable) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closable, onClose])

  // Keep focus on the replacement control when hold/resume swap the buttons,
  // and on the dialog itself when the run controls disappear.
  const holdBtnRef = useRef<HTMLButtonElement>(null)
  const resumeBtnRef = useRef<HTMLButtonElement>(null)
  const prevHeldRef = useRef(held)
  const prevControlsVisibleRef = useRef(active && !failed && !complete)
  useEffect(() => {
    const controlsVisible = active && !failed && !complete
    const prevHeld = prevHeldRef.current
    const prevVisible = prevControlsVisibleRef.current
    prevHeldRef.current = held
    prevControlsVisibleRef.current = controlsVisible
    if (prevVisible && !controlsVisible) {
      dialogRef.current?.focus()
    } else if (controlsVisible && prevHeld !== held) {
      ;(held ? resumeBtnRef.current : holdBtnRef.current)?.focus()
    }
  }, [held, active, failed, complete])

  // Keep Tab navigation inside the dialog.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) {
      e.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || active === dialog)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-3 sm:p-6"
      onClick={() => { if (closable) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="parallel-results-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-xl max-h-[85vh] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl flex flex-col animate-in"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            <div id="parallel-results-title" className="flex items-center gap-2 text-text-primary font-semibold text-lg">
              Parallelism — {run.probeAxis} {run.probeAxis === 'Z' ? 'surface' : 'edge'} / {run.stepAxis} scan
            </div>
            <p className="mt-1 text-sm text-text-muted truncate">
              {run.npts} points · step {fmt(run.stepMm)} {unitLabel}
            </p>
          </div>
          <button
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated disabled:opacity-50"
            onClick={onClose}
            title="Close"
            disabled={!closable}
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
          <span
            aria-live="polite"
            aria-atomic="true"
            className={`font-semibold ${failed ? 'text-danger' : complete ? 'text-ok' : 'text-accent'}`}
          >
            {failed
              ? 'Probe failed — see the probe panel for the reason'
              : complete
                ? 'Measurement complete'
                : `${held ? 'Cycle held' : `Measuring… point ${Math.min(finalCount + 1, run.npts)}/${run.npts}`}`}
          </span>
          <span className="text-xs text-text-muted">Deviation vs point 1</span>
        </div>

        <div className="overflow-auto max-h-[45vh] rounded border border-border bg-elevated/30 font-mono text-sm">
          <table className="w-full text-right">
            <thead>
              <tr className="text-text-dim text-xs uppercase tracking-wide">
                <th className="px-3 py-2 font-semibold text-left">#</th>
                <th className="px-3 py-2 font-semibold">{run.stepAxis} position ({unitLabel})</th>
                <th className="px-3 py-2 font-semibold">{run.probeAxis} value ({unitLabel})</th>
                <th className="px-3 py-2 font-semibold">Deviation ({unitLabel})</th>
              </tr>
            </thead>
            <tbody>
              {run.points.length === 0 && <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-dim">Waiting for first probe…</td>
              </tr>}
              {run.points.map(p => <tr key={p.index} className="border-t border-border">
                <td className="px-3 py-1.5 text-left">{p.index + 1}</td>
                <td className="px-3 py-1.5">{fmt(p.stepPos)}</td>
                <td className={`px-3 py-1.5 ${p.final ? '' : 'text-text-dim'}`}>
                  {fmt(p.value)}{p.final ? '' : ' *'}
                </td>
                <td className={`px-3 py-1.5 ${Math.abs(p.value - baseline) > 0.05 ? 'text-warn' : 'text-ok'}`}>
                  {(p.value - baseline >= 0 ? '+' : '') + fmt(p.value - baseline)}
                </td>
              </tr>)}
              {run.points.length > 0 && run.points.length < run.npts && <tr>
                <td colSpan={4} className="px-3 py-2 text-center text-text-dim border-t border-border">
                  {failed ? 'Stopped' : 'Measuring next point…'}
                </td>
              </tr>}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 flex items-center justify-between gap-3 border-t border-border">
          <span className="text-sm font-semibold text-text-primary">
            Max deviation:{' '}
            <span className={`font-mono ${Math.abs(maxDev) > 0.05 ? 'text-warn' : 'text-ok'}`}>
              {(maxDev >= 0 ? '+' : '') + fmt(maxDev)} {unitLabel}
            </span>
          </span>
          {active && !failed && !complete && <div className="flex gap-2">
            {held
              ? <>
                <button ref={resumeBtnRef} className="btn btn-ok justify-center gap-2 h-10 px-4" onClick={onResume}>
                  <Play size={16} /> Resume
                </button>
                <button className="btn btn-danger justify-center gap-2 h-10 px-4" onClick={onAbort}>
                  <Square className="fill-current" size={14} /> Abort
                </button>
              </>
              : <button ref={holdBtnRef} className="btn btn-danger justify-center gap-2 h-10 px-4" onClick={onHold}>
                <Pause size={16} /> Feed hold
              </button>}
          </div>}
          {closable && <button className="btn btn-primary justify-center h-10 px-6" onClick={onClose}>
            Close
          </button>}
        </div>

        <p className="px-4 pb-3 text-xs text-text-dim">
          Values marked * are preliminary (fast pass) and are replaced by the slow precision pass.
        </p>
      </div>
    </div>
  )
}
