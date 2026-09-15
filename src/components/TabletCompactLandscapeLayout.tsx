import { DRO } from './DRO'
import { TabletJogPad } from './JogPad'
import { TabletAccordion } from './TabletAccordion'
import { PluginFrame } from './PluginFrame'
import type { Plugin } from '../types'
import type { TabletTabId } from '../lib/tabletTabs'
import {
  useCompactLandscapeTabContentHeight,
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
  'flex flex-col flex-1 min-w-0 basis-1/2 self-stretch'

/**
 * Short-viewport landscape tablets (layout height < 640px):
 *   Row 1 — POSITION | JOG (side by side, equal height)
 *   Row 2 — tabbed workspace (sized to the viewport; page scrolls to it)
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
  const workspaceHeight = useCompactLandscapeTabContentHeight()
  const pluginPanelStyle = workspaceHeight != null ? { height: workspaceHeight } : undefined

  return (
    <div className="flex flex-col gap-5 p-3">
      <div
        className="flex flex-row gap-2 shrink-0 items-stretch"
        style={topRowHeight != null ? { minHeight: topRowHeight } : undefined}
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
          <div className="panel flex flex-col min-h-0 overflow-hidden" style={pluginPanelStyle}>
            <PluginFrame plugin={workspacePlugin} onClose={onCloseWorkspacePlugin} inline />
          </div>
        ) : controlsPlugin && onCloseControlsPlugin ? (
          <div className="panel flex flex-col min-h-0 overflow-hidden" style={pluginPanelStyle}>
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
