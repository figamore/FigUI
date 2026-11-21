import { uiText as __uiText, formatUi } from '../lib/i18n'
import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'
import { doorPhaseText, isDoorBlocked } from '../lib/door'

export function ManualATCPrompt() {
  const enabled = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const machineState = useMachineStore(s => s.status.state)
  const doorPhase = useMachineStore(s => s.status.doorPhase)
  const phase = useManualAtcStore(s => s.phase)
  const requestedTool = useManualAtcStore(s => s.requestedTool)
  const resumeToolChange = useManualAtcStore(s => s.resumeToolChange)

  if (!enabled || (phase !== 'awaiting-tool' && phase !== 'resuming')) return null

  // A door opened during the change leaves FluidNC in Door; Door:0 resumes like Hold.
  const doorBlocked = isDoorBlocked({ state: machineState, doorPhase })
  const ready = phase === 'awaiting-tool' && (machineState === 'Hold' || (machineState === 'Door' && !doorBlocked))
  return <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center sm:p-4">
    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
    <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-lg border border-border bg-surface p-5 shadow-2xl">
      <h2 className="text-xl font-semibold text-text-primary">
        {requestedTool != null ? formatUi(__uiText("components.ManualATCPrompt.dynamic.1", "Install Tool T{v0}"), { v0: requestedTool }) : __uiText("components.ManualATCPrompt.change_tool.1", "Change Tool")}
      </h2>
      <p className="mt-3 text-lg font-medium leading-snug text-text-primary">{__uiText("components.ManualATCPrompt.install_the_next_tool_and_continue_.1", "Install the next tool and continue when ready.")}</p>
      <button className="btn btn-ok-solid mt-5 h-12 w-full justify-center text-lg" disabled={!ready} onClick={resumeToolChange}>
        {phase === 'resuming' ? __uiText("components.ManualATCPrompt.proceeding.1", "Proceeding…") : doorBlocked ? doorPhaseText(doorPhase) : ready ? __uiText("components.ManualATCPrompt.ready.1", "Ready") : __uiText("components.ManualATCPrompt.moving_to_change_position.1", "Moving to Change Position…")}
      </button>
    </div>
  </div>
}
