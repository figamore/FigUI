import { AlertTriangle } from 'lucide-react'

export function WebUIBlocked({ base, onReload }: { base: string; onReload: () => void }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)] p-6 overflow-y-auto">
      <AlertTriangle size={28} className="text-warn shrink-0" />
      <h1 className="text-text-primary text-base font-medium text-center">
        Cannot load WebUI while GCode Program is Running
      </h1>
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-4">
          <a className="btn btn-warn-solid justify-center min-w-24" href={`${base}/feedhold_reload`}>Pause</a>
          <span className="text-text-muted text-sm">Pause the GCode program with feedhold</span>
        </div>
        <div className="flex items-center gap-4">
          <a className="btn btn-danger-solid justify-center min-w-24" href={`${base}/restart_reload`}>Stop</a>
          <span className="text-text-muted text-sm">Stop the GCode Program with reset</span>
        </div>
        <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
          <button className="btn btn-primary" onClick={onReload}>Reload WebUI</button>
          <span className="text-text-muted text-sm">
            You must first stop the GCode program or wait for it to finish.
          </span>
        </div>
      </div>
    </div>
  )
}
