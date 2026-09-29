import { GCodeViewer } from './GCodeViewer'
import { FileManager } from './FileManager'
import { Macros } from './Macros'
import { ProbePanel } from './ProbePanel'
import { ManualATCPanel } from './ManualATCPanel'
import { Terminal } from './Terminal'
import { OverridesPanel, SpindlePanel } from './JogPad'
import { PluginLauncher } from './PluginLauncher'
import type { Plugin } from '../types'
import type { TabletTabDef, TabletTabId } from '../lib/tabletTabs'

interface TabletTabbedPanelProps {
  tabs: TabletTabDef[]
  activeTab: TabletTabId
  onTabChange: (tab: TabletTabId) => void
  onLaunchPanel?: (plugin: Plugin) => void
  hasProbingInput: boolean
  hasSpindle: boolean
  hasManualATC?: boolean
  /** Fixed content height in px; panels fill it instead of sizing to content. */
  contentHeight?: number
  portraitMinHeight?: boolean
  tabLabelFontSize?: string
  fitToViewSignal?: boolean
}

export function TabletTabbedPanel({
  tabs,
  activeTab,
  onTabChange,
  onLaunchPanel,
  hasProbingInput,
  hasSpindle,
  hasManualATC = false,
  contentHeight,
  portraitMinHeight = false,
  tabLabelFontSize = 'clamp(10px, 2.2vw, 20px)',
  fitToViewSignal,
}: TabletTabbedPanelProps) {
  const fills = contentHeight != null
  const contentClass = fills
    ? 'shrink-0 overflow-hidden'
    : portraitMinHeight
      ? 'min-h-[420px] overflow-hidden'
      : undefined
  const padded = fills ? 'h-full overflow-y-auto p-3' : 'p-3'
  const paddedWide = fills ? 'h-full overflow-y-auto p-5' : 'p-5'

  return (
    <div className="panel flex flex-col">
      <div className="flex w-full border-b border-border shrink-0 overflow-x-auto">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`min-w-0 flex-1 px-1 py-2 font-medium uppercase tracking-wide whitespace-nowrap transition-colors border-b-2 -mb-px flex flex-col items-center justify-center gap-0.5 ${
              activeTab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
            style={{ fontSize: tabLabelFontSize }}
          >
            <Icon size={15} className="shrink-0" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className={contentClass} style={fills ? { height: contentHeight } : undefined}>
        {activeTab === 'viewer' && (
          <div className={`flex flex-col gap-3 p-3 ${fills ? 'h-full' : ''}`}>
            <GCodeViewer
              className={fills ? 'flex-1 min-h-0' : 'min-h-[55vh]'}
              isTablet
              fitToViewSignal={fitToViewSignal}
            />
          </div>
        )}
        {activeTab === 'files' && <FileManager isTablet />}
        {activeTab === 'macros' && <Macros isTablet />}
        {activeTab === 'tooling' && hasManualATC && (
          <div className={padded}>
            <ManualATCPanel isTablet embedded />
          </div>
        )}
        {activeTab === 'probing' && hasProbingInput && (
          <div className={padded}>
            <ProbePanel isTablet embedded />
          </div>
        )}
        {activeTab === 'terminal' && <Terminal />}
        {activeTab === 'spindle' && hasSpindle && (
          <div className={paddedWide}>
            <SpindlePanel className="border-none shadow-none p-0" isTablet />
          </div>
        )}
        {activeTab === 'overrides' && (
          <div className={paddedWide}>
            <OverridesPanel className="border-none shadow-none p-0" isTablet />
          </div>
        )}
        {activeTab === 'plugins' && (
          <PluginLauncher isTablet onLaunchPanel={onLaunchPanel} activeLayout="tablet" />
        )}
      </div>
    </div>
  )
}
