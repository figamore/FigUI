import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useMachineStore } from '../store'
import { formatAxisCoord, isRotaryAxis } from '../lib/units'
import { parseAxisPosition, type AxisPositionAction, type AxisPositionMode } from '../lib/axisPosition'
import type { Units } from '../types'

export function AxisPositionDialog({ axis, mode, value, units, disabled, onAction, onClose }: {
  axis: string
  mode: AxisPositionMode
  value: number
  units: Units
  disabled: boolean
  onAction: (action: AxisPositionAction, input: string) => boolean
  onClose: () => void
}) {
  const [draft, setDraft] = useState(() => formatAxisCoord(value, axis, units).trim())
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const controllerUnits = useMachineStore(s => s.status.gcodeModes?.units)
  const unitLabel = isRotaryAxis(axis) ? '°' : units
  const invalid = parseAxisPosition(draft) === null
  const unitsUnknown = !isRotaryAxis(axis) && controllerUnits !== 'G20' && controllerUnits !== 'G21'

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => dialog.close()
  }, [])

  function submit(action: AxisPositionAction) {
    if (disabled || invalid || (action === 'set' && unitsUnknown)) return
    if (onAction(action, draft)) onClose()
    else setError('Command could not be sent.')
  }

  return <dialog ref={dialogRef} aria-labelledby="axis-position-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && event.target === inputRef.current) event.preventDefault() }}
    className="m-auto w-[calc(100%-2rem)] max-w-xs max-h-[calc(100svh-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="flex items-center justify-between gap-2 mb-3">
      <div>
        <h2 id="axis-position-title" className="text-lg font-semibold">{axis} position</h2>
        <div className="text-xs text-text-muted">{mode === 'WPos' ? 'Work' : 'Machine'} · {unitLabel}</div>
      </div>
      <button className="btn btn-ghost h-10 w-10 p-0" onClick={onClose} aria-label="Close position editor"><X size={18} /></button>
    </div>
    <input ref={inputRef} inputMode="decimal" type="text" autoComplete="off" spellCheck={false} maxLength={24}
      aria-label={`${axis} ${mode === 'WPos' ? 'work' : 'machine'} position in ${unitLabel}`}
      value={draft} onChange={event => { setDraft(event.target.value.replace(',', '.')); setError('') }}
      className="w-full h-12 rounded border border-border bg-elevated px-3 font-mono text-2xl tabular-nums focus:outline-none focus:border-accent" />
    <p className={`my-3 text-xs leading-relaxed ${error ? 'text-danger' : 'text-text-muted'}`} role={error ? 'alert' : undefined}>
      {error || (disabled ? 'Machine must be idle.' : mode === 'MPos' ? 'Go moves to this machine position.' : 'Set changes the coordinate. Go moves the axis.')}
    </p>
    <div className="flex gap-2">
      {mode === 'WPos' && <button className="btn btn-ghost flex-1 h-11" disabled={disabled || invalid || unitsUnknown}
        title={unitsUnknown ? 'Waiting for controller units' : `Set current ${axis} work position to this value`} onClick={() => submit('set')}>Set</button>}
      <button className="btn btn-ok-solid flex-1 h-11" disabled={disabled || invalid} onClick={() => submit('go')}>Go</button>
    </div>
  </dialog>
}
