import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useMachineStore } from '../store'
import { formatAxisCoord, isRotaryAxis } from '../lib/units'
import { parseAxisPosition, type AxisPositionAction, type AxisPositionMode } from '../lib/axisPosition'
import type { Units } from '../types'

export function AxisPositionDialog({ axis, mode, value, units, isTablet = false, disabled, onAction, onClose }: {
  axis: string
  mode: AxisPositionMode
  value: number
  units: Units
  isTablet?: boolean
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

  function press(key: string) {
    const input = inputRef.current!
    let start = input.selectionStart ?? draft.length
    const end = input.selectionEnd ?? start
    let next: string
    let selectionEnd: number
    if (key === '±') {
      next = draft.startsWith('-') ? draft.slice(1) : `-${draft}`
      const selectedAll = start === 0 && end === draft.length
      start = selectedAll ? (next.startsWith('-') ? 1 : 0) : next.length
      selectionEnd = selectedAll ? next.length : start
    } else {
      if (key === '⌫' && start === end) start = Math.max(0, start - 1)
      next = draft.slice(0, start) + (key === '⌫' ? '' : key) + draft.slice(end)
      if (key !== '⌫') start += key.length
      selectionEnd = start
    }
    if (!/^-?\d*\.?\d*$/.test(next) || next.length > 24) return
    setDraft(next)
    setError('')
    input.focus()
    requestAnimationFrame(() => input.setSelectionRange(start, selectionEnd))
  }

  function submit(action: AxisPositionAction) {
    if (disabled || invalid || (action === 'set' && unitsUnknown)) return
    if (onAction(action, draft)) onClose()
    else setError('Command could not be sent.')
  }

  return <dialog ref={dialogRef} aria-labelledby="axis-position-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && event.target === inputRef.current) event.preventDefault() }}
    className={`m-auto w-[calc(100%-2rem)] ${isTablet ? 'max-w-xl' : 'max-w-xs'} max-h-[calc(100svh-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-text-primary shadow-2xl backdrop:bg-black/60`}>
    <div className="flex items-center justify-between gap-2 mb-3">
      <div>
        <h2 id="axis-position-title" className={`font-semibold ${isTablet ? 'text-2xl' : 'text-lg'}`}>{axis} position</h2>
        <div className={`text-text-muted ${isTablet ? 'text-sm' : 'text-xs'}`}>{mode === 'WPos' ? 'Work' : 'Machine'} · {unitLabel}</div>
      </div>
      <button className={`btn btn-ghost p-0 ${isTablet ? 'h-14 w-14' : 'h-10 w-10'}`} onClick={onClose} aria-label="Close position editor"><X size={isTablet ? 24 : 18} /></button>
    </div>
    <div className={isTablet ? 'grid grid-cols-2 gap-3' : ''}>
      <div className="min-w-0 flex flex-col">
        <div className="flex items-center rounded border border-border bg-elevated focus-within:border-accent">
          <input ref={inputRef} inputMode={isTablet ? 'none' : 'decimal'} type="text" autoComplete="off" spellCheck={false} maxLength={24}
            aria-label={`${axis} ${mode === 'WPos' ? 'work' : 'machine'} position in ${unitLabel}`}
            value={draft} onChange={event => { setDraft(event.target.value.replace(',', '.')); setError('') }}
            className={`min-w-0 w-full bg-transparent px-3 font-mono tabular-nums focus:outline-none ${isTablet ? 'h-16 text-3xl' : 'h-12 text-2xl'}`} />
          {isTablet && <button className="btn btn-ghost h-16 w-14 shrink-0 p-0 text-2xl" aria-label="Backspace"
            onMouseDown={event => event.preventDefault()} onClick={() => press('⌫')}>⌫</button>}
        </div>
        <p className={`my-3 flex-1 leading-relaxed ${isTablet ? 'text-sm' : 'text-xs'} ${error ? 'text-danger' : 'text-text-muted'}`} role={error ? 'alert' : undefined}>
          {error || (disabled ? 'Machine must be idle.' : mode === 'MPos' ? 'Go moves to this machine position.' : 'Set changes the coordinate. Go moves the axis.')}
        </p>
        <div className="flex gap-2">
          {mode === 'WPos' && <button className={`btn btn-ghost flex-1 ${isTablet ? 'h-16 text-xl' : 'h-11'}`} disabled={disabled || invalid || unitsUnknown}
            title={unitsUnknown ? 'Waiting for controller units' : `Set current ${axis} work position to this value`} onClick={() => submit('set')}>Set</button>}
          <button className={`btn btn-ok-solid flex-1 ${isTablet ? 'h-16 text-xl' : 'h-11'}`} disabled={disabled || invalid} onClick={() => submit('go')}>Go</button>
        </div>
      </div>
      {isTablet && <div className="grid grid-cols-3 gap-2">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3', '±', '0', '.'].map(key => <button key={key}
          className="btn btn-ghost h-16 bg-elevated text-2xl [@media(max-height:420px)]:h-12" onMouseDown={event => event.preventDefault()} onClick={() => press(key)}
          aria-label={key === '±' ? 'Toggle sign' : key === '.' ? 'Decimal point' : key}>{key}</button>)}
      </div>}
    </div>
  </dialog>
}
