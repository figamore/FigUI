import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useMachineStore } from '../store'
import { useHoldMonitorStore } from '../store/holdMonitor'
import { useManualAtcStore } from '../store/manualAtc'
import { useJobResume } from '../lib/jobResume'

export function HoldPrompt() {
  const current = useHoldMonitorStore(s => s.current)
  const dismissed = useHoldMonitorStore(s => s.dismissed)
  const dismiss = useHoldMonitorStore(s => s.dismiss)
  const reopen = useHoldMonitorStore(s => s.reopen)
  const state = useMachineStore(s => s.status.state)
  const atcPhase = useManualAtcStore(s => s.phase)
  const manualAtc = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const { disabled, stepHold, resume } = useJobResume()
  const [resuming, setResuming] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const atcPrompt = manualAtc && (atcPhase === 'awaiting-tool' || atcPhase === 'resuming')
  const message = current?.message
  const visible = !!message && !atcPrompt
  const open = visible && !dismissed

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    dialog.showModal()
    // Enter must not accidentally resume when the prompt first appears.
    titleRef.current?.focus()
    return () => dialog.close()
  }, [open, current?.id])

  useEffect(() => { setResuming(false) }, [current?.id])
  useEffect(() => {
    if (!resuming) return
    const timeout = setTimeout(() => setResuming(false), 1500)
    return () => clearTimeout(timeout)
  }, [resuming])

  if (!visible) return null
  const resumeLabel = resuming ? 'Resuming…' : state === 'Door' ? 'Close door' : disabled ? 'Waiting…' : stepHold ? 'Next block' : 'Resume'

  return <>
    {dismissed && <button onClick={reopen} className="flex items-center gap-3 border-b border-warn/30 bg-warn/10 px-4 py-2 text-left text-sm text-warn shrink-0" title="Open pause instructions">
      <Pause size={16} className="shrink-0" />
      <span className="truncate flex-1">{message}</span>
      <span className="shrink-0 font-medium">View pause</span>
    </button>}
    <dialog ref={dialogRef} aria-labelledby="hold-title" aria-describedby="hold-message"
      onCancel={event => { event.preventDefault(); dismiss() }}
      className="m-auto w-[calc(100%-2rem)] max-w-md max-h-[85svh] overflow-y-auto rounded-xl border border-border bg-surface p-0 text-text-primary shadow-2xl backdrop:bg-black/60">
      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warn/10 text-warn shrink-0"><Pause size={20} /></span>
          <h2 id="hold-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold outline-none">Program paused</h2>
        </div>
        <p id="hold-message" className="mt-5 text-base leading-relaxed whitespace-pre-wrap break-words">{message}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button className="btn btn-ghost h-11 flex-1 justify-center" onClick={dismiss}>Stay paused</button>
          <button className="btn btn-ok-solid h-11 flex-1 justify-center gap-2" disabled={disabled || resuming || state === 'Door'} onClick={() => { if (resume()) setResuming(true) }}>
            <Play size={16} className="shrink-0" />{resumeLabel}
          </button>
        </div>
      </div>
    </dialog>
  </>
}
