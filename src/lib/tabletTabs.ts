import { uiText as __uiText } from './i18n'
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
    { id: 'viewer', label: __uiText("lib.tabletTabs.viewer.1", "Viewer"), Icon: Eye },
    { id: 'files', label: __uiText("lib.tabletTabs.files.1", "Files"), Icon: FolderOpen },
    { id: 'macros', label: __uiText("lib.tabletTabs.macros.1", "Macros"), Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling' as const, label: __uiText("lib.tabletTabs.tooling.1", "Tooling"), Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing' as const, label: __uiText("lib.tabletTabs.probing.1", "Probing"), Icon: Target }] : []),
    { id: 'terminal', label: __uiText("lib.tabletTabs.terminal.1", "Terminal"), Icon: TerminalSquare },
    { id: 'plugins', label: __uiText("lib.tabletTabs.plugins.1", "Plugins"), Icon: Puzzle },
  ]
}

export function buildFullTabletTabs(
  hasProbingInput: boolean,
  hasSpindle: boolean,
  hasManualATC = false,
): TabletTabDef[] {
  return [
    { id: 'viewer', label: __uiText("lib.tabletTabs.viewer.2", "Viewer"), Icon: Eye },
    { id: 'files', label: __uiText("lib.tabletTabs.files.2", "Files"), Icon: FolderOpen },
    { id: 'macros', label: __uiText("lib.tabletTabs.macros.2", "Macros"), Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling' as const, label: __uiText("lib.tabletTabs.tooling.2", "Tooling"), Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing' as const, label: __uiText("lib.tabletTabs.probing.2", "Probing"), Icon: Target }] : []),
    { id: 'terminal', label: __uiText("lib.tabletTabs.terminal.2", "Terminal"), Icon: TerminalSquare },
    ...(hasSpindle ? [{ id: 'spindle' as const, label: __uiText("lib.tabletTabs.spindle.1", "Spindle"), Icon: Power }] : []),
    { id: 'overrides', label: __uiText("lib.tabletTabs.overrides.1", "Overrides"), Icon: Sliders },
    { id: 'plugins', label: __uiText("lib.tabletTabs.plugins.2", "Plugins"), Icon: Puzzle },
  ]
}
