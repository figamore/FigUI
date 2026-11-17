import { uiText as __uiText } from '../lib/i18n'
import { Play, Pause, Square, RotateCcw, DoorOpen, StepForward } from 'lucide-react'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { formatJobProgress, formatRuntime, useJobRuntimeEstimate } from '../lib/jobRuntime'
import { useControllerJobStarting } from '../lib/jobState'
import { sendRealtime, sendRealtimeNow } from '../lib/ws'
import { clearMachineAlarm } from '../lib/alarm'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { SingleBlockNotice, SingleBlockToggle } from './SingleBlockControl'
import { useJobResume } from '../lib/jobResume'

export function JobControl() {
  const status = useMachineStore(s => s.status)
  const connected = useMachineStore(s => s.connected)
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
  // A file streamed from the browser has no SD name; it needs the sender's
  // own pause, resume and abort, as in the Viewer.
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const pauseSender = useGCodeSenderStore(s => s.pause)
  const abortSender = useGCodeSenderStore(s => s.abort)
  const senderActive = ['streaming', 'paused', 'draining'].includes(senderPhase)
  const senderPaused = senderPhase === 'paused'
  const { stepHold, disabled: resumeDisabled, resume } = useJobResume()

  const isRunning = (state === 'Run' && !senderPaused) || controllerJobStarting || controllerResetPending
    || senderPhase === 'streaming' || senderPhase === 'draining'
  const isHold    = state === 'Hold' || senderPaused
  const isAlarm   = state === 'Alarm'
  const isDoor    = state === 'Door'
  const hasSd     = Boolean(sdFilename)

  function pause()      { if (senderActive) pauseSender(); else sendRealtime(0x21) }
  function softReset()  {
    if (!confirm(__uiText("components.JobControl.notice.1", "Abort job and reset?"))) return
    if (senderActive) abortSender()
    else if (sendRealtimeNow(0x18)) cancelTrackedJob('controller')
  }
  function clearAlarm() { clearMachineAlarm(status.alarmCode) }

  if (!hasSd && !senderActive && !isAlarm && !isHold && !isDoor && !controllerJobStarting && !controllerResetPending) return null

  return (
    <div className="panel">
      <div className="panel-header">{__uiText("components.JobControl.job_control.1", "Job Control")}</div>
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
                  {runtime.source === 'sd' ? __uiText("components.JobControl.file.1", "File ") : ''}{formatJobProgress(progressPercent, runtime.source)}
                </span>
              </div>
            )}
            {runtime.source === 'estimated' && (
              <div className="flex justify-between text-sm font-mono text-text-muted tabular-nums">
                <span>{__uiText("components.JobControl.elapsed.1", "Elapsed")} {formatRuntime(runtime.elapsedSeconds)}</span>
                <span>{__uiText("components.JobControl.remain.1", "Remain")} {formatRuntime(runtime.remainingSeconds)}</span>
                <span>{__uiText("components.JobControl.total.1", "Total")} {formatRuntime(runtime.totalSeconds)}</span>
              </div>
            )}
            {runtime.source === 'sd' && progressPercent != null && (
              <div className="flex justify-between text-xs font-mono text-text-muted tabular-nums">
                <span>{progressPercent.toFixed(1)}%</span>
                {runtime.remainingSeconds != null && (
                  <span title={__uiText("components.JobControl.estimated_from_sd_file_progress.1", "Estimated from SD file progress")}>{__uiText("components.JobControl.remain.2", "Remain ~")}{formatRuntime(runtime.remainingSeconds)}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Door state notice */}
        {isDoor && (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-warn/10
                          border border-warn/30 text-sm text-warn">
            <DoorOpen size={13} className="shrink-0" />
            <span>{__uiText("components.JobControl.door_open_close_door_then_resume.1", "Door open — close door then resume")}</span>
          </div>
        )}

        {/* Alarm state notice */}
        {isAlarm && (
          <div className="px-3 py-2 rounded bg-danger/10 border border-danger/30
                          text-sm text-danger text-center">
            {__uiText("components.JobControl.alarm_check_machine_before_unlockin.1", "ALARM — check machine before unlocking")}
          </div>
        )}

        {/* Action buttons */}
        {isRunning ? (
          <div className="flex gap-2">
            <button className="btn btn-warn-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={pause} disabled={!connected}>
              <Pause size={13} />
              {__uiText("components.JobControl.hold.1", "Hold")}
            </button>
            <button className="btn btn-danger-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              {__uiText("components.JobControl.abort.1", "Abort")}
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {(isHold || isDoor) ? (
              <button className={`btn ${stepHold ? 'btn-step' : 'btn-ok-solid'} job-action gap-1.5 text-sm justify-center flex-1`} onClick={resume} disabled={resumeDisabled}>
                {stepHold ? <StepForward size={13} /> : <Play size={13} />}
                {stepHold ? __uiText("components.JobControl.next_block.1", "Next block") : __uiText("components.JobControl.resume.1", "Resume")}
              </button>
            ) : (
              <button className="btn btn-warn-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={pause} disabled>
                <Pause size={13} />
                {__uiText("components.JobControl.hold.2", "Hold")}
              </button>
            )}

            <button className="btn btn-danger-solid job-action gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              {__uiText("components.JobControl.abort.2", "Abort")}
            </button>

            {(isAlarm || isDoor) && (
              <button className="btn btn-ghost gap-1.5 text-sm justify-center flex-1 min-h-[44px]" onClick={clearAlarm}>
                <RotateCcw size={13} />
                {__uiText("components.JobControl.unlock.1", "Unlock")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
