import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from '../icons'
import { ProgramExecutionPanel } from './ProgramExecutionPanel'
import { TabletTabbedPanel } from './TabletTabbedPanel'
import { GCodeViewer } from './GCodeViewer'
import { FileManager } from './FileManager'
import { Macros } from './Macros'
import { ProbePanel } from './ProbePanel'
import { ManualATCPanel } from './ManualATCPanel'
import { Terminal } from './Terminal'
import { OverridesPanel, SpindlePanel } from './JogPad'
import { PluginLauncher } from './PluginLauncher'
import type { Plugin } from '../types'
import { useMachineStore } from '../store'
import {
  buildFullTabletTabs,
  buildLandscapeAccordionTabs,
  type TabletTabId,
} from '../lib/tabletTabs'
import { COMPACT_LANDSCAPE_VIEWER_CLASS } from '../lib/compactLandscapeLayout'
import { useIsPortrait } from '../lib/viewport'

interface TabletAccordionProps {
  tabletTab: TabletTabId
  setTabletTab: (tab: TabletTabId) => void
  onLaunchPanel?: (plugin: Plugin) => void
  /** Full-width tab strip below Position/Jog (compact landscape category). */
  variant?: 'default' | 'stacked'
}

export function TabletAccordion({
  tabletTab,
  setTabletTab,
  onLaunchPanel,
  variant = 'default',
}: TabletAccordionProps) {
  const [expanded, setExpanded] = useState<'visualizer' | 'program' | 'controls'>('visualizer')
  const isPortrait = useIsPortrait()
  const spindleMax = useMachineStore(s => s.controllerSettings.spindleMax)
  const hasSpindle = Boolean(spindleMax)
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasProbingInput = Boolean(reportedHasProbe || reportedHasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const status = useMachineStore(s => s.status)
  const isProgramRunning = (status.state === 'Run' || status.state === 'Hold')
    && (!!status.sdFilename || status.plannerLineNumber != null)

  const landscapeTabs = useMemo(
    () => buildLandscapeAccordionTabs(hasProbingInput, hasManualATC),
    [hasProbingInput, hasManualATC],
  )
  const fullTabs = useMemo(
    () => buildFullTabletTabs(hasProbingInput, hasSpindle, hasManualATC),
    [hasProbingInput, hasSpindle, hasManualATC],
  )

  useEffect(() => {
    if (!isProgramRunning && expanded === 'program') setExpanded('visualizer')
    if (!hasProbingInput && tabletTab === 'probing') setTabletTab('viewer')
    if (!hasManualATC && tabletTab === 'tooling') setTabletTab('viewer')

    const activeTabs = variant === 'stacked' || isPortrait ? fullTabs : landscapeTabs
    if (!activeTabs.some(t => t.id === tabletTab)) setTabletTab('viewer')
  }, [
    isProgramRunning,
    expanded,
    hasProbingInput,
    hasManualATC,
    tabletTab,
    setTabletTab,
    variant,
    isPortrait,
    fullTabs,
    landscapeTabs,
  ])

  if (variant === 'stacked') {
    return (
      <div className="flex flex-col gap-2">
        {isProgramRunning && <ProgramExecutionPanel isTablet />}
        <TabletTabbedPanel
          tabs={fullTabs}
          activeTab={tabletTab}
          onTabChange={setTabletTab}
          onLaunchPanel={onLaunchPanel}
          hasProbingInput={hasProbingInput}
          hasSpindle={hasSpindle}
          hasManualATC={hasManualATC}
          tabLabelFontSize="clamp(10px, 1.6vw, 18px)"
          viewerClassName={COMPACT_LANDSCAPE_VIEWER_CLASS}
        />
      </div>
    )
  }

  return (
    <div className="portrait:shrink-0 landscape:flex-1 landscape:basis-1/2 landscape:min-h-0 landscape:overflow-hidden flex flex-col">

      <div className="portrait:flex landscape:hidden flex-col gap-3">
        {isProgramRunning && <ProgramExecutionPanel isTablet />}
        <TabletTabbedPanel
          tabs={fullTabs}
          activeTab={tabletTab}
          onTabChange={setTabletTab}
          onLaunchPanel={onLaunchPanel}
          hasProbingInput={hasProbingInput}
          hasSpindle={hasSpindle}
          hasManualATC={hasManualATC}
          portraitMinHeight
        />
      </div>

      <div className="landscape:flex portrait:hidden flex-col gap-3 flex-1 min-h-0 overflow-hidden">

        <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'visualizer' ? 'flex-1 min-h-0' : 'shrink-0'}`}>
          {expanded !== 'visualizer' && (
            <button
              className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
              onClick={() => setExpanded('visualizer')}
            >
              <span>{landscapeTabs.find(t => t.id === tabletTab)?.label}</span>
              <ChevronRight size={22} />
            </button>
          )}
          {expanded === 'visualizer' && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex w-full border-b border-border shrink-0">
                {landscapeTabs.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTabletTab(id)}
                    className={`min-w-0 flex-1 px-1 py-2 font-medium uppercase tracking-wide whitespace-nowrap transition-colors border-b-2 -mb-px flex flex-col items-center justify-center gap-0.5 ${
                      tabletTab === id
                        ? 'border-accent text-accent'
                        : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                    style={{ fontSize: 'clamp(10px, 1.35vw, 20px)' }}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span>{label}</span>
                  </button>
                ))}
                <button onClick={() => setExpanded('controls')} className="w-11 shrink-0 hover:text-text-primary text-text-muted flex items-center justify-center">
                  <ChevronDown size={22} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <div className={`h-full flex flex-col gap-3 p-3 overflow-y-auto ${tabletTab !== 'viewer' ? 'hidden' : ''}`}>
                  <GCodeViewer className="flex-1 min-h-[300px]" isTablet fitToViewSignal={expanded === 'visualizer'} />
                </div>
                {tabletTab === 'files' && <FileManager isTablet />}
                {tabletTab === 'macros' && <Macros isTablet />}
                {tabletTab === 'tooling' && hasManualATC && (
                  <div className="h-full overflow-y-auto p-3"><ManualATCPanel isTablet embedded /></div>
                )}
                {tabletTab === 'probing' && hasProbingInput && (
                  <div className="h-full overflow-y-auto p-3"><ProbePanel isTablet embedded /></div>
                )}
                {tabletTab === 'terminal' && <Terminal />}
                {tabletTab === 'plugins' && (
                  <PluginLauncher isTablet onLaunchPanel={onLaunchPanel} activeLayout="tablet" />
                )}
              </div>
            </div>
          )}
        </div>

        {isProgramRunning && (
          <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'program' ? 'flex-1 min-h-0' : 'shrink-0'}`}>
            {expanded !== 'program' ? (
              <button
                className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
                onClick={() => setExpanded('program')}
              >
                <span className="uppercase tracking-wide">Program execution</span>
                <ChevronRight size={22} />
              </button>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <button
                  className="panel-header flex justify-between items-center border-b border-border cursor-pointer hover:text-text-primary shrink-0 text-xl py-3"
                  onClick={() => setExpanded('visualizer')}
                >
                  <span className="uppercase tracking-wide">Program execution</span>
                  <ChevronDown size={22} />
                </button>
                <ProgramExecutionPanel isTablet accordionManaged />
              </div>
            )}
          </div>
        )}

        <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'controls' ? 'flex-1 min-h-0 overflow-y-auto' : 'shrink-0'}`}>
          {expanded !== 'controls' && (
            <button
              className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
              onClick={() => setExpanded('controls')}
            >
              <span className="uppercase tracking-wide">{hasSpindle ? 'Spindle & Overrides' : 'Overrides'}</span>
              <ChevronRight size={22} />
            </button>
          )}
          {expanded === 'controls' && (
            <div className="flex flex-col flex-1 min-h-0">
              <button
                className="panel-header flex justify-between items-center border-b border-border cursor-pointer hover:text-text-primary shrink-0 text-xl py-3"
                onClick={() => setExpanded('visualizer')}
              >
                <span className="uppercase tracking-wide">{hasSpindle ? 'Spindle & Overrides' : 'Overrides'}</span>
                <ChevronDown size={22} />
              </button>
              <div className="flex-1 overflow-y-auto flex flex-col gap-0 p-0">
                {hasSpindle && (
                  <>
                    <SpindlePanel className="border-none shadow-none p-0" isTablet />
                    <div className="h-px bg-border w-full my-1" />
                  </>
                )}
                <OverridesPanel className="border-none shadow-none p-0" isTablet />
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  )
}
