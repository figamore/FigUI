import { Play, Pause, Square, RotateCcw, DoorOpen, StepForward } from 'lucide-react'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { formatJobProgress, formatRuntime, useJobRuntimeEstimate } from '../lib/jobRuntime'
import { useControllerJobStarting } from '../lib/jobState'
import { sendRealtime, sendRealtimeNow } from '../lib/ws'
import { clearMachineAlarm } from '../lib/alarm'
import { useSingleBlockStore } from '../store/singleBlock'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { SingleBlockNotice, SingleBlockToggle } from './SingleBlockControl'

export function JobControl() {
  const status = useMachineStore(s => s.status)
  const controllerResetPending = useMachineStore(s => s.controllerResetPending)
  const controllerJobStarting = useControllerJobStarting()
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const model = useGCodeStore(s => s.model)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const fileName = useGCodeStore(s => s.fileName)
  const { state, sdFilename } = status
  const runtime = useJobRuntimeEstimate(status, model, controllerSettings, loadedPath, fileName)
  const progressPercent = runtime.progressPercent
  const cancelTrackedJob = useGCodeStore(s => s.cancelTrackedJob)
  const connected = useMachineStore(s => s.connected)
  const pendingBlock = useSingleBlockStore(s => s.pendingBlock)
  const ready = useSingleBlockStore(s => s.ready)
  const advancing = useSingleBlockStore(s => s.advancing)
  const modePending = useSingleBlockStore(s => s.requestedMode !== null)
  const resumeController = useSingleBlockStore(s => s.resume)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderActive = ['streaming', 'paused', 'draining'].includes(senderPhase)
  const stepHold = status.state === 'Hold' && status.pinState.includes('Q') && (!!pendingBlock || advancing) && !senderActive
  const resumeDisabled = !connected || controllerResetPending || (senderActive
    ? status.state === 'Door'
    : modePending || advancing || status.holdComplete === false || (status.state === 'Hold' && !!pendingBlock && !ready))

  const isRunning = state === 'Run' || controllerJobStarting || controllerResetPending
  const isHold    = state === 'Hold'
  const isAlarm   = state === 'Alarm'
  const isDoor    = state === 'Door'
  const hasSd     = Boolean(sdFilename)

  function resume()     {
    if (senderActive) useGCodeSenderStore.getState().resume()
    else resumeController()
  }
  function pause()      { sendRealtime(0x21) }
  function softReset()  {
    if (!confirm('Abort job and reset?')) return
    if (sendRealtimeNow(0x18)) cancelTrackedJob('controller')
  }
  function clearAlarm() { clearMachineAlarm(status.alarmCode) }

  if (!hasSd && !isAlarm && !isHold && !isDoor && !controllerJobStarting && !controllerResetPending) return null

  return (
    <div className="panel">
      <div className="panel-header">Job Control</div>
      <div className="p-4 space-y-3">
        <SingleBlockToggle unavailable={senderActive} />
        <SingleBlockNotice unavailable={senderActive} />

        {/* SD progress */}
        {hasSd && (
          <div className="space-y-1.5">
            <div className="text-sm text-text-muted font-mono truncate">{sdFilename}</div>
            {progressPercent != null && (
              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div
                    className="h-full bg-info transition-all duration-500 rounded-full"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="text-sm font-mono text-text-muted tabular-nums shrink-0">
                  {runtime.source === 'sd' ? 'File ' : ''}{formatJobProgress(progressPercent, runtime.source)}
                </span>
              </div>
            )}
            {runtime.source === 'estimated' && (
              <div className="flex justify-between text-sm font-mono text-text-muted tabular-nums">
                <span>Elapsed {formatRuntime(runtime.elapsedSeconds)}</span>
                <span>Remain {formatRuntime(runtime.remainingSeconds)}</span>
                <span>Total {formatRuntime(runtime.totalSeconds)}</span>
              </div>
            )}
          </div>
        )}

        {/* Door state notice */}
        {isDoor && (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-warn/10
                          border border-warn/30 text-sm text-warn">
            <DoorOpen size={13} className="shrink-0" />
            <span>Door open — close door then resume</span>
          </div>
        )}

        {/* Alarm state notice */}
        {isAlarm && (
          <div className="px-3 py-2 rounded bg-danger/10 border border-danger/30
                          text-sm text-danger text-center">
            ALARM — check machine before unlocking
          </div>
        )}

        {/* Action buttons */}
        {isRunning ? (
          <div className="flex gap-2">
            <button className="btn btn-warn-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={pause}>
              <Pause size={13} />
              Hold
            </button>
            <button className="btn btn-danger-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              Abort
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {(isHold || isDoor) ? (
              <button className={`btn ${stepHold ? 'btn-step' : 'btn-ok-solid'} job-action gap-1.5 text-sm justify-center flex-1`} onClick={resume} disabled={resumeDisabled}>
                {stepHold ? <StepForward size={13} /> : <Play size={13} />}
                {stepHold ? 'Next block' : 'Resume'}
              </button>
            ) : (
              <button className="btn btn-warn-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={pause} disabled>
                <Pause size={13} />
                Hold
              </button>
            )}

            <button className="btn btn-danger-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              Abort
            </button>

            {(isAlarm || isDoor) && (
              <button className="btn btn-ghost gap-1.5 text-sm justify-center flex-1" onClick={clearAlarm}>
                <RotateCcw size={13} />
                Unlock
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
