import { Eye, FolderOpen, Puzzle, Sliders, Target, TerminalSquare, Wrench, Zap } from '../icons'
import { Power } from '../icons'

export type TabletTabId =
  | 'viewer'
  | 'files'
  | 'macros'
  | 'tooling'
  | 'probing'
  | 'terminal'
  | 'spindle'
  | 'overrides'
  | 'plugins'

export interface TabletTabDef {
  id: TabletTabId
  label: string
  Icon: typeof Eye
}

export function buildLandscapeAccordionTabs(
  hasProbingInput: boolean,
  hasManualATC = false,
): TabletTabDef[] {
  return [
    { id: 'viewer', label: 'Viewer', Icon: Eye },
    { id: 'files', label: 'Files', Icon: FolderOpen },
    { id: 'macros', label: 'Macros', Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling' as const, label: 'Tooling', Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing' as const, label: 'Probing', Icon: Target }] : []),
    { id: 'terminal', label: 'Terminal', Icon: TerminalSquare },
    { id: 'plugins', label: 'Plugins', Icon: Puzzle },
  ]
}

export function buildFullTabletTabs(
  hasProbingInput: boolean,
  hasSpindle: boolean,
  hasManualATC = false,
): TabletTabDef[] {
  return [
    { id: 'viewer', label: 'Viewer', Icon: Eye },
    { id: 'files', label: 'Files', Icon: FolderOpen },
    { id: 'macros', label: 'Macros', Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling' as const, label: 'Tooling', Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing' as const, label: 'Probing', Icon: Target }] : []),
    { id: 'terminal', label: 'Terminal', Icon: TerminalSquare },
    ...(hasSpindle ? [{ id: 'spindle' as const, label: 'Spindle', Icon: Power }] : []),
    { id: 'overrides', label: 'Overrides', Icon: Sliders },
    { id: 'plugins', label: 'Plugins', Icon: Puzzle },
  ]
}
