import { uiText as __uiText } from '../lib/i18n'
import { AlertTriangle } from 'lucide-react'

export function WebUIBlocked({ base, onReload }: { base: string; onReload: () => void }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)] p-6 overflow-y-auto">
      <AlertTriangle size={28} className="text-warn shrink-0" />
      <h1 className="text-text-primary text-base font-medium text-center">
        {__uiText("components.WebUIBlocked.cannot_load_webui_while_gcode_progr.1", "Cannot load WebUI while GCode Program is Running")}
      </h1>
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-4">
          <a className="btn btn-warn-solid justify-center min-w-24" href={`${base}/feedhold_reload`}>{__uiText("components.WebUIBlocked.pause.1", "Pause")}</a>
          <span className="text-text-muted text-sm">{__uiText("components.WebUIBlocked.pause_the_gcode_program_with_feedho.1", "Pause the GCode program with feedhold")}</span>
        </div>
        <div className="flex items-center gap-4">
          <a className="btn btn-danger-solid justify-center min-w-24" href={`${base}/restart_reload`}>{__uiText("components.WebUIBlocked.stop.1", "Stop")}</a>
          <span className="text-text-muted text-sm">{__uiText("components.WebUIBlocked.stop_the_gcode_program_with_reset.1", "Stop the GCode Program with reset")}</span>
        </div>
        <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
          <button className="btn btn-primary" onClick={onReload}>{__uiText("components.WebUIBlocked.reload_webui.1", "Reload WebUI")}</button>
          <span className="text-text-muted text-sm">
            {__uiText("components.WebUIBlocked.you_must_first_stop_the_gcode_progr.1", "You must first stop the GCode program or wait for it to finish.")}
          </span>
        </div>
      </div>
    </div>
  )
}
