import { DRO } from './DRO'
import { TabletJogPad } from './JogPad'
import { TabletAccordion } from './TabletAccordion'
import { PluginFrame } from './PluginFrame'
import type { Plugin } from '../types'
import type { TabletTabId } from '../lib/tabletTabs'
import {
  COMPACT_LANDSCAPE_PLUGIN_MIN_HEIGHT,
  useCompactLandscapeTopRowHeight,
} from '../lib/compactLandscapeLayout'

interface TabletCompactLandscapeLayoutProps {
  tabletTab: TabletTabId
  setTabletTab: (tab: TabletTabId) => void
  onLaunchPanel?: (plugin: Plugin) => void
  jogPlugin: Plugin | null
  onCloseJogPlugin: () => void
  workspacePlugin?: Plugin | null
  onCloseWorkspacePlugin?: () => void
  controlsPlugin?: Plugin | null
  onCloseControlsPlugin?: () => void
}

const TOP_ROW_COLUMN_CLASS =
  'flex flex-col flex-1 min-w-0 basis-1/2 h-full min-h-0 overflow-hidden'

/**
 * Short-viewport landscape tablets (layout height < 640px):
 *   Row 1 — POSITION | JOG (side by side, equal height)
 *   Row 2 — tabbed workspace (natural height; page scrolls)
 */
export function TabletCompactLandscapeLayout({
  tabletTab,
  setTabletTab,
  onLaunchPanel,
  jogPlugin,
  onCloseJogPlugin,
  workspacePlugin,
  onCloseWorkspacePlugin,
  controlsPlugin,
  onCloseControlsPlugin,
}: TabletCompactLandscapeLayoutProps) {
  const topRowHeight = useCompactLandscapeTopRowHeight()

  return (
    <div className="flex flex-col gap-2 p-3">
      <div
        className="flex flex-row gap-2 shrink-0 items-stretch overflow-hidden"
        style={topRowHeight != null ? { height: topRowHeight } : undefined}
      >
        <div className={TOP_ROW_COLUMN_CLASS}>
          <DRO isTablet layout="topBand" />
        </div>
        <div className={TOP_ROW_COLUMN_CLASS}>
          {jogPlugin ? (
            <div className="panel flex flex-col h-full min-h-0 overflow-hidden">
              <PluginFrame plugin={jogPlugin} onClose={onCloseJogPlugin} inline />
            </div>
          ) : (
            <TabletJogPad layout="topBand" />
          )}
        </div>
      </div>

      <div className="flex flex-col shrink-0">
        {workspacePlugin && onCloseWorkspacePlugin ? (
          <div className="panel flex flex-col" style={{ minHeight: COMPACT_LANDSCAPE_PLUGIN_MIN_HEIGHT }}>
            <PluginFrame plugin={workspacePlugin} onClose={onCloseWorkspacePlugin} inline />
          </div>
        ) : controlsPlugin && onCloseControlsPlugin ? (
          <div className="panel flex flex-col" style={{ minHeight: COMPACT_LANDSCAPE_PLUGIN_MIN_HEIGHT }}>
            <PluginFrame plugin={controlsPlugin} onClose={onCloseControlsPlugin} inline />
          </div>
        ) : (
          <TabletAccordion
            variant="stacked"
            tabletTab={tabletTab}
            setTabletTab={setTabletTab}
            onLaunchPanel={onLaunchPanel}
          />
        )}
      </div>
    </div>
  )
}
