import { LoaderCircle, StepForward, Turtle, X } from 'lucide-react'
import { useMachineStore } from '../store'
import { supportsSingleBlock } from '../lib/singleBlock'
import { useSingleBlockStore } from '../store/singleBlock'

export function SingleBlockToggle({ isTablet, unavailable = false }: { isTablet?: boolean; unavailable?: boolean }) {
  const connected = useMachineStore(s => s.connected)
  const resetting = useMachineStore(s => s.controllerResetPending)
  const supported = useMachineStore(s => supportsSingleBlock(s.espInfo?.version))
  const enabled = useMachineStore(s => s.status.pinState.includes('Q'))
  const requestedMode = useSingleBlockStore(s => s.requestedMode)
  const setMode = useSingleBlockStore(s => s.setMode)
  const pending = requestedMode !== null
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-busy={pending}
      aria-label={`Single block mode${enabled ? ' enabled' : ' disabled'}`}
      className={`btn job-action gap-2 shrink-0 ${isTablet ? 'text-base' : 'text-sm'} ${enabled && supported ? 'border-warn/50 bg-warn/10 text-warn' : 'btn-ghost'}`}
      disabled={!supported || !connected || resetting || pending || unavailable}
      onClick={() => setMode(!enabled)}
      title={!supported
        ? 'FluidNC must be greater than 4.1.1'
        : unavailable
          ? 'Available for controller files and macros'
          : enabled ? 'Turn off; Resume continues the job' : 'Pause before each program line'}
    >
      {pending ? <LoaderCircle size={16} className="animate-spin" /> : <Turtle size={16} />}
      <span>Single block</span>
      <span className={`h-1.5 w-1.5 rounded-full ${enabled && supported ? 'bg-warn' : 'bg-text-dim'}`} aria-hidden="true" />
    </button>
  )
}

/** Reserve both rows through motion, empty previews, and mode changes. */
export function SingleBlockNotice({ unavailable = false }: { unavailable?: boolean }) {
  const connected = useMachineStore(s => s.connected)
  const idle = useMachineStore(s => s.status.state === 'Idle')
  const enabled = useMachineStore(s => s.status.pinState.includes('Q'))
  const pendingBlock = useSingleBlockStore(s => s.pendingBlock)
  const block = useSingleBlockStore(s => s.displayedBlock)
  const advancing = useSingleBlockStore(s => s.advancing)
  const requestedMode = useSingleBlockStore(s => s.requestedMode)
  const ready = useSingleBlockStore(s => s.ready)
  const error = useSingleBlockStore(s => s.error)
  const clearError = useSingleBlockStore(s => s.clearError)
  if (!connected || (!enabled && !pendingBlock && !error && requestedMode === null)) return null
  const label = error ? 'Single block'
    : requestedMode !== null ? 'Updating mode'
    : unavailable ? 'Controller files only'
    : pendingBlock ? (enabled ? (ready ? 'Next' : 'Pausing') : 'Paused')
    : advancing || block ? 'Running' : 'Single block on'
  const showStartHint = enabled && idle && !block && !advancing && requestedMode === null && !unavailable
  const detail = error ?? (showStartHint ? 'Press Start to begin in single block mode.' : unavailable ? '—' : block?.preview || '—')
  return (
    <div role="status" className={`single-block-readout flex items-start gap-2 rounded border px-3 py-2 text-sm ${error ? 'border-danger/30 bg-danger/5 text-danger' : 'border-warn/25 bg-warn/5 text-text-muted'}`}>
      <StepForward size={15} className={`mt-0.5 shrink-0 ${error ? 'text-danger' : 'text-warn'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center gap-2 overflow-hidden">
          <span className={`shrink-0 font-semibold ${error ? 'text-danger' : 'text-warn'}`}>
            {label}{block && !error && !unavailable && requestedMode === null ? ` · Line ${block.line}` : ''}
          </span>
          {block && !error && <span className="min-w-0 truncate font-mono" title={block.path}>{block.path}</span>}
        </div>
        <div className={`h-5 truncate text-text-primary ${showStartHint && !error ? '' : 'font-mono'}`} title={detail}>
          {detail}
        </div>
      </div>
      {error && <button type="button" className="shrink-0 rounded p-0.5 hover:bg-danger/10" onClick={clearError} aria-label="Dismiss single block error"><X size={14} /></button>}
    </div>
  )
}
