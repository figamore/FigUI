import { DRO } from './DRO'
import { TabletJogPad } from './JogPad'
import { TabletAccordion } from './TabletAccordion'
import { TabletCompactLandscapeLayout } from './TabletCompactLandscapeLayout'
import { PluginFrame } from './PluginFrame'
import type { Plugin } from '../types'
import type { TabletTabId } from '../lib/tabletTabs'
import { useIsCompactLandscape } from '../lib/viewport'

interface TabletMainShellProps {
  tabletTab: TabletTabId
  setTabletTab: (tab: TabletTabId) => void
  onLaunchPanel?: (plugin: Plugin) => void
  jogPlugin: Plugin | null
  onCloseJogPlugin: () => void
  workspacePlugin: Plugin | null
  onCloseWorkspacePlugin: () => void
  controlsPlugin: Plugin | null
  onCloseControlsPlugin: () => void
}

const TABLET_LEFT_COLUMN_CLASS =
  'flex flex-col gap-1 portrait:shrink-0 landscape:flex-1 landscape:basis-1/2 landscape:min-h-0 landscape:overflow-hidden'

function TabletLeftColumn({
  jogPlugin,
  onCloseJogPlugin,
}: {
  jogPlugin: Plugin | null
  onCloseJogPlugin: () => void
}) {
  return (
    <div className={TABLET_LEFT_COLUMN_CLASS}>
      <div className="landscape:shrink-0">
        <DRO isTablet />
      </div>
      {jogPlugin ? (
        <div className="panel flex flex-col flex-1 min-h-0 overflow-hidden">
          <PluginFrame plugin={jogPlugin} onClose={onCloseJogPlugin} inline />
        </div>
      ) : (
        <TabletJogPad />
      )}
    </div>
  )
}

export function TabletMainShell({
  tabletTab,
  setTabletTab,
  onLaunchPanel,
  jogPlugin,
  onCloseJogPlugin,
  workspacePlugin,
  onCloseWorkspacePlugin,
  controlsPlugin,
  onCloseControlsPlugin,
}: TabletMainShellProps) {
  const isCompactLandscape = useIsCompactLandscape()

  if (isCompactLandscape) {
    return (
      <TabletCompactLandscapeLayout
        tabletTab={tabletTab}
        setTabletTab={setTabletTab}
        onLaunchPanel={onLaunchPanel}
        jogPlugin={jogPlugin}
        onCloseJogPlugin={onCloseJogPlugin}
        workspacePlugin={workspacePlugin}
        onCloseWorkspacePlugin={onCloseWorkspacePlugin}
        controlsPlugin={controlsPlugin}
        onCloseControlsPlugin={onCloseControlsPlugin}
      />
    )
  }

  const shellClass =
    'flex-1 min-h-[0px] flex portrait:flex-col landscape:flex landscape:flex-row gap-3 p-3 overflow-y-auto landscape:overflow-hidden'

  if (workspacePlugin) {
    return (
      <div className={shellClass}>
        <TabletLeftColumn jogPlugin={jogPlugin} onCloseJogPlugin={onCloseJogPlugin} />
        <div className="panel flex flex-col landscape:flex-1 landscape:basis-1/2 landscape:min-h-0 portrait:min-h-[55vh] landscape:overflow-hidden">
          <PluginFrame plugin={workspacePlugin} onClose={onCloseWorkspacePlugin} inline />
        </div>
      </div>
    )
  }

  if (controlsPlugin) {
    return (
      <div className={shellClass}>
        <div className="panel flex flex-col portrait:shrink-0 landscape:flex-1 landscape:basis-1/2 landscape:min-h-0 portrait:min-h-[55vh] landscape:overflow-hidden">
          <PluginFrame plugin={controlsPlugin} onClose={onCloseControlsPlugin} inline />
        </div>
        <TabletAccordion
          tabletTab={tabletTab}
          setTabletTab={setTabletTab}
          onLaunchPanel={onLaunchPanel}
        />
      </div>
    )
  }

  return (
    <div className={shellClass}>
      <TabletLeftColumn jogPlugin={jogPlugin} onCloseJogPlugin={onCloseJogPlugin} />
      <TabletAccordion tabletTab={tabletTab} setTabletTab={setTabletTab} onLaunchPanel={onLaunchPanel} />
    </div>
  )
}
