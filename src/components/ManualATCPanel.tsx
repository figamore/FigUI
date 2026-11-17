import { uiText as __uiText } from '../lib/i18n'
import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'
import { Wrench } from '../icons'

export function ManualATCPanel({ isTablet, embedded = false }: { isTablet?: boolean; embedded?: boolean }) {
  const connected = useMachineStore(s => s.connected)
  const status = useMachineStore(s => s.status)
  const settings = useMachineStore(s => s.controllerSettings)
  const completeReferenceSetup = useManualAtcStore(s => s.completeReferenceSetup)
  const requestToolChange = useManualAtcStore(s => s.requestToolChange)

  if (settings.hasManualATC !== true) return null

  const idle = connected && status.state === 'Idle'
  const currentTool = status.gcodeModes?.tool
  const xyPlane = status.gcodeModes?.plane == null || status.gcodeModes.plane === 'G17'
  const buttonClass = `btn w-full justify-center ${isTablet ? 'h-16 text-xl' : 'h-11 text-base'}`

  return <div className={embedded ? '' : 'panel'}>
    {!embedded && <div className="panel-header justify-between">
      <div className="flex items-center gap-2">
        <Wrench size={isTablet ? 20 : 15} />
        <span className="text-lg font-semibold">{__uiText("components.ManualATCPanel.manual_atc.1", "Manual ATC")}</span>
      </div>
      {currentTool != null && currentTool > 0 && <span className="text-text-muted">{__uiText("components.ManualATCPanel.tool_t.1", "Tool T")}{currentTool}</span>}
    </div>}
    <div className="grid grid-cols-2 gap-2 p-3">
      <button
        className={`${buttonClass} btn-ghost`}
        disabled={!idle}
        title={__uiText("components.ManualATCPanel.after_setting_z_zero_register_the_c.1", "After setting Z zero, register the current tool as Tool 1")}
        onClick={completeReferenceSetup}
      >
        {__uiText("components.ManualATCPanel.set_tool_1.1", "Set Tool 1")}
      </button>
      <button
        className={`${buttonClass} btn-warn`}
        disabled={!idle || !xyPlane}
        title={!xyPlane ? __uiText("components.ManualATCPanel.manual_tool_change_requires_g17.1", "Manual tool change requires G17") : undefined}
        onClick={requestToolChange}
      >
        {__uiText("components.ManualATCPanel.change_tool.1", "Change Tool")}
      </button>
    </div>
  </div>
}
