import { uiText as __uiText } from '../lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ResizeHandle } from './ResizeHandle'
import { DRO } from './DRO'
import { JogPad } from './JogPad'
import { GCodeViewer } from './GCodeViewer'
import { ProbeOrProgramPanel } from './ProgramExecutionPanel'
import { Terminal } from './Terminal'
import { FileManager } from './FileManager'
import { Macros } from './Macros'
import { PluginLauncher } from './PluginLauncher'
import { PluginFrame } from './PluginFrame'
import { useMachineStore } from '../store'
import type { Plugin, SidebarTab, ActiveLayout } from '../types'

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: 'files',   label: __uiText("components.DesktopLayout.label_extra.1", "Files")   },
  { id: 'macros',  label: __uiText("components.DesktopLayout.label_extra.2", "Macros")  },
  { id: 'plugins', label: __uiText("components.DesktopLayout.label_extra.3", "Plugins") },
]

const HANDLE_W           = 8
const LEFT_DEFAULT       = 380
const RIGHT_DEFAULT      = 340
const LEFT_MIN           = 190
const RIGHT_MIN          = 190
const CENTER_MIN         = 240
const RIGHT_TOP_MIN      = 15
const RIGHT_TOP_MAX      = 85
const TERM_EXP_PCT_MIN   = 15
const TERM_EXP_PCT_MAX   = 65
const STORAGE_KEY        = 'fluidui-desktop-layout'

interface SavedLayout {
  leftWidth: number
  rightWidth: number
  rightTopPct: number
  terminalExpanded: boolean
  terminalExpandedPct: number
}

function loadLayout(): SavedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<SavedLayout>
      return {
        leftWidth:          typeof p.leftWidth          === 'number'  ? p.leftWidth          : LEFT_DEFAULT,
        rightWidth:         typeof p.rightWidth         === 'number'  ? p.rightWidth         : RIGHT_DEFAULT,
        rightTopPct:        typeof p.rightTopPct        === 'number'  ? p.rightTopPct        : 65,
        terminalExpanded:   typeof p.terminalExpanded   === 'boolean' ? p.terminalExpanded   : false,
        terminalExpandedPct:typeof p.terminalExpandedPct=== 'number'  ? p.terminalExpandedPct: 30,
      }
    }
  } catch { /* ignore */ }
  return { leftWidth: LEFT_DEFAULT, rightWidth: RIGHT_DEFAULT, rightTopPct: 65, terminalExpanded: false, terminalExpandedPct: 30 }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

interface Props {
  workspacePlugin: Plugin | null
  controlsPlugin:  Plugin | null
  jogPlugin:       Plugin | null
  onCloseWorkspacePlugin: () => void
  onCloseControlsPlugin:  () => void
  onCloseJogPlugin:       () => void
  onLaunchPanel: (plugin: Plugin) => void
  activeLayout: ActiveLayout
}

export function DesktopLayout({
  workspacePlugin,
  controlsPlugin,
  jogPlugin,
  onCloseWorkspacePlugin,
  onCloseControlsPlugin,
  onCloseJogPlugin,
  onLaunchPanel,
  activeLayout,
}: Props) {
  const contentDirection = typeof document === 'undefined' ? 'ltr' : (document.documentElement.dir || 'ltr')
  const sidebarTab    = useMachineStore(s => s.sidebarTab)
  const setSidebarTab = useMachineStore(s => s.setSidebarTab)

  const saved = useRef(loadLayout())
  const [leftWidth,           setLeftWidth]           = useState(saved.current.leftWidth)
  const [rightWidth,          setRightWidth]          = useState(saved.current.rightWidth)
  const [rightTopPct,         setRightTopPct]         = useState(saved.current.rightTopPct)
  const [terminalExpanded,    setTerminalExpanded]    = useState(saved.current.terminalExpanded)
  const [terminalExpandedPct, setTerminalExpandedPct] = useState(saved.current.terminalExpandedPct)
  const [leftCollapsed,       setLeftCollapsed]       = useState(false)
  const [rightCollapsed,      setRightCollapsed]      = useState(false)
  const [dragging,            setDragging]            = useState<'h' | 'v' | false>(false)

  const containerRef  = useRef<HTMLDivElement>(null)
  const rightColRef   = useRef<HTMLDivElement>(null)
  const leftWidthRef  = useRef(leftWidth)
  const rightWidthRef = useRef(rightWidth)
  leftWidthRef.current  = leftWidth
  rightWidthRef.current = rightWidth

  // Reset layout to defaults
  useEffect(() => {
    const handler = () => {
      setLeftWidth(LEFT_DEFAULT)
      setRightWidth(RIGHT_DEFAULT)
      setRightTopPct(65)
      setTerminalExpanded(false)
      setTerminalExpandedPct(30)
      setLeftCollapsed(false)
      setRightCollapsed(false)
      localStorage.removeItem(STORAGE_KEY)
    }
    window.addEventListener('reset-layout', handler)
    return () => window.removeEventListener('reset-layout', handler)
  }, [])

  // Debounced persist
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        leftWidth, rightWidth, rightTopPct, terminalExpanded, terminalExpandedPct,
      }))
    }, 400)
    return () => clearTimeout(saveTimer.current)
  }, [leftWidth, rightWidth, rightTopPct, terminalExpanded, terminalExpandedPct])

  // Lock cursor + selection during drag
  useEffect(() => {
    if (!dragging) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      return
    }
    document.body.style.cursor = dragging === 'h' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])

  useEffect(() => {
    setLeftCollapsed(false)
    setRightCollapsed(false)
  }, [!!workspacePlugin, !!controlsPlugin])

  const onDragEnd = useCallback(() => setDragging(false), [])

  const adjustLeft = useCallback((delta: number) => {
    const w = containerRef.current?.clientWidth ?? 1200
    const max = w - rightWidthRef.current - CENTER_MIN - 2 * HANDLE_W
    setLeftWidth(prev => clamp(prev + delta, LEFT_MIN, Math.max(LEFT_MIN, max)))
  }, [])

  const adjustRight = useCallback((delta: number) => {
    const w = containerRef.current?.clientWidth ?? 1200
    const max = w - leftWidthRef.current - CENTER_MIN - 2 * HANDLE_W
    setRightWidth(prev => clamp(prev - delta, RIGHT_MIN, Math.max(RIGHT_MIN, max)))
  }, [])

  const adjustRightTop = useCallback((delta: number) => {
    const h = rightColRef.current?.clientHeight ?? 600
    setRightTopPct(prev => clamp(prev + (delta / h) * 100, RIGHT_TOP_MIN, RIGHT_TOP_MAX))
  }, [])

  const adjustTerminalExpanded = useCallback((delta: number) => {
    const h = containerRef.current?.clientHeight ?? 600
    setTerminalExpandedPct(prev => clamp(prev - (delta / h) * 100, TERM_EXP_PCT_MIN, TERM_EXP_PCT_MAX))
  }, [])

  const onLeftDragStart = useCallback(() => {
    if (leftCollapsed) { setLeftCollapsed(false); setLeftWidth(0) }
    setDragging('h')
  }, [leftCollapsed])

  const onRightDragStart = useCallback(() => {
    if (rightCollapsed) { setRightCollapsed(false); setRightWidth(0) }
    setDragging('h')
  }, [rightCollapsed])

  const prevLeftWidth  = useRef(leftWidth)
  const prevRightWidth = useRef(rightWidth)

  function toggleLeft() {
    if (leftCollapsed) {
      setLeftCollapsed(false)
    } else {
      prevLeftWidth.current = leftWidth
      setLeftCollapsed(true)
    }
  }

  function toggleRight() {
    if (rightCollapsed) {
      setRightCollapsed(false)
    } else {
      prevRightWidth.current = rightWidth
      setRightCollapsed(true)
    }
  }

  function toggleTerminalExpanded() {
    setTerminalExpanded(prev => !prev)
  }

  const noTransition = dragging !== false
  const wTransition  = noTransition ? 'none' : 'width 180ms ease'

  const sidebarTabBar = (
    <div className="flex border-b border-border shrink-0">
      {SIDEBAR_TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => setSidebarTab(tab.id)}
          title={tab.label}
          className={`min-w-0 flex-1 py-2.5 text-sm xl:text-base font-medium uppercase tracking-wide transition-colors border-b-2 -mb-px ${
            sidebarTab === tab.id
              ? 'border-accent text-accent'
              : 'border-transparent text-text-muted'
          }`}
        >
          <span className="block truncate">{tab.label}</span>
        </button>
      ))}
    </div>
  )

  const sidebarContent = (
    <div className="flex-1 min-h-0 overflow-hidden">
      {sidebarTab === 'files'   && <FileManager />}
      {sidebarTab === 'macros'  && <Macros />}
      {sidebarTab === 'plugins' && <PluginLauncher onLaunchPanel={onLaunchPanel} activeLayout={activeLayout} />}
    </div>
  )

  // Left panel content (scrollable inner, clipping outer)
  function leftPanelOuter(children: React.ReactNode) {
    return (
      <div
        className="shrink-0"
        style={{ width: leftCollapsed ? 0 : leftWidth, minWidth: 0, overflow: 'hidden', transition: wTransition }}
      >
        <div dir={contentDirection} className="flex flex-col gap-3 overflow-y-auto h-full" style={{ width: leftWidth }}>
          {children}
        </div>
      </div>
    )
  }

  // Right column: vertical split (files + terminal) or files only when terminal expanded
  const rightColumnNormal = (
    <div ref={rightColRef} className="flex flex-col h-full min-h-0">
      <div className="panel flex flex-col overflow-hidden" style={{ flex: rightTopPct, minHeight: 0 }}>
        {sidebarTabBar}
        {sidebarContent}
      </div>
      <ResizeHandle
        direction="vertical"
        onDelta={adjustRightTop}
        onDragStart={() => setDragging('v')}
        onDragEnd={onDragEnd}
        dragging={dragging === 'v'}
      />
      <div className="panel flex flex-col overflow-hidden" style={{ flex: 100 - rightTopPct, minHeight: 0 }}>
        <Terminal onExpandToggle={toggleTerminalExpanded} expanded={terminalExpanded} />
      </div>
    </div>
  )

  const rightColumnFilesOnly = (
    <div className="panel flex flex-col h-full min-h-0 overflow-hidden">
      {sidebarTabBar}
      {sidebarContent}
    </div>
  )

  function rightPanelOuter(children: React.ReactNode) {
    return (
      <div
        className="shrink-0"
        style={{ width: rightCollapsed ? 0 : rightWidth, minWidth: 0, overflow: 'hidden', transition: wTransition }}
      >
        <div dir={contentDirection} className="h-full" style={{ width: rightWidth }}>
          {children}
        </div>
      </div>
    )
  }

  // ── Horizontal row shared by all layout variants ───────────────────────────
  function horizontalRow(
    leftContent: React.ReactNode,
    centerContent: React.ReactNode,
    rightContent: React.ReactNode,
    opts: { leftCollapsible?: boolean; rightCollapsible?: boolean } = {},
  ) {
    const { leftCollapsible = true, rightCollapsible = true } = opts
    return (
      <>
        {leftPanelOuter(leftContent)}
        <ResizeHandle
          collapseToward={leftCollapsible ? 'left' : undefined}
          collapsed={leftCollapsed}
          onCollapseToggle={leftCollapsible ? toggleLeft : undefined}
          onDelta={adjustLeft}
          onDragStart={onLeftDragStart}
          onDragEnd={onDragEnd}
          dragging={dragging === 'h'}
        />
        <div dir={contentDirection} className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
          {centerContent}
        </div>
        <ResizeHandle
          collapseToward={rightCollapsible ? 'right' : undefined}
          collapsed={rightCollapsed}
          onCollapseToggle={rightCollapsible ? toggleRight : undefined}
          onDelta={adjustRight}
          onDragStart={onRightDragStart}
          onDragEnd={onDragEnd}
          dragging={dragging === 'h'}
        />
        {rightPanelOuter(rightContent)}
      </>
    )
  }

  const jogSlot = jogPlugin ? (
    <div className="panel flex flex-col flex-1 min-h-0 overflow-hidden">
      <PluginFrame plugin={jogPlugin} onClose={onCloseJogPlugin} inline />
    </div>
  ) : (
    <JogPad />
  )

  // ── Standard layout ────────────────────────────────────────────────────────
  if (!workspacePlugin && !controlsPlugin) {
    const leftContent  = <><DRO />{jogSlot}</>
    const centerContent = (
      <>
        <GCodeViewer className="flex-1 min-h-[300px]" />
        <ProbeOrProgramPanel />
      </>
    )

    if (terminalExpanded) {
      return (
        <div ref={containerRef} dir="ltr" className="flex flex-1 min-h-0 p-3 overflow-hidden">
          {leftPanelOuter(leftContent)}
          <ResizeHandle
            collapseToward="left"
            collapsed={leftCollapsed}
            onCollapseToggle={toggleLeft}
            onDelta={adjustLeft}
            onDragStart={onLeftDragStart}
            onDragEnd={onDragEnd}
            dragging={dragging === 'h'}
          />
          <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
            <div className="flex min-h-0 overflow-hidden" style={{ flex: 100 - terminalExpandedPct }}>
              <div dir={contentDirection} className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
                {centerContent}
              </div>
              <ResizeHandle
                collapseToward="right"
                collapsed={rightCollapsed}
                onCollapseToggle={toggleRight}
                onDelta={adjustRight}
                onDragStart={onRightDragStart}
                onDragEnd={onDragEnd}
                dragging={dragging === 'h'}
              />
              {rightPanelOuter(rightColumnFilesOnly)}
            </div>
            <ResizeHandle
              direction="vertical"
              onDelta={adjustTerminalExpanded}
              onDragStart={() => setDragging('v')}
              onDragEnd={onDragEnd}
              dragging={dragging === 'v'}
            />
            <div dir={contentDirection} className="panel flex flex-col overflow-hidden" style={{ flex: terminalExpandedPct, minHeight: 0 }}>
              <Terminal onExpandToggle={toggleTerminalExpanded} expanded={terminalExpanded} />
            </div>
          </div>
        </div>
      )
    }

    return (
      <div ref={containerRef} dir="ltr" className="flex flex-1 min-h-0 p-3 overflow-hidden">
        {horizontalRow(leftContent, centerContent, rightColumnNormal)}
      </div>
    )
  }

  // ── Workspace plugin ───────────────────────────────────────────────────────
  if (workspacePlugin) {
    return (
      <div ref={containerRef} dir="ltr" className="flex flex-1 min-h-0 p-3 overflow-hidden">
        {leftPanelOuter(<><DRO />{jogSlot}</>)}
        <ResizeHandle
          collapseToward="left"
          collapsed={leftCollapsed}
          onCollapseToggle={toggleLeft}
          onDelta={adjustLeft}
          onDragStart={onLeftDragStart}
          onDragEnd={onDragEnd}
          dragging={dragging === 'h'}
        />
        <div dir={contentDirection} className="panel flex flex-col flex-1 min-w-0 overflow-hidden">
          <PluginFrame plugin={workspacePlugin} onClose={onCloseWorkspacePlugin} inline />
        </div>
      </div>
    )
  }

  // ── Controls plugin ────────────────────────────────────────────────────────
  const controlsContent = (
    <div
      className="panel flex flex-col shrink-0 overflow-hidden"
      style={{ width: leftCollapsed ? 0 : leftWidth, minWidth: 0, transition: wTransition }}
    >
      <div dir={contentDirection} className="h-full" style={{ width: leftWidth }}>
        <PluginFrame plugin={controlsPlugin!} onClose={onCloseControlsPlugin} inline />
      </div>
    </div>
  )

  const centerContent = (
    <>
      <GCodeViewer className="flex-1 min-h-[300px]" />
      <ProbeOrProgramPanel />
    </>
  )

  if (terminalExpanded) {
    return (
      <div ref={containerRef} dir="ltr" className="flex flex-1 min-h-0 p-3 overflow-hidden">
        {controlsContent}
        <ResizeHandle
          collapseToward="left"
          collapsed={leftCollapsed}
          onCollapseToggle={toggleLeft}
          onDelta={adjustLeft}
          onDragStart={onLeftDragStart}
          onDragEnd={onDragEnd}
          dragging={dragging === 'h'}
        />
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          <div className="flex min-h-0 overflow-hidden" style={{ flex: 100 - terminalExpandedPct }}>
            <div dir={contentDirection} className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
              {centerContent}
            </div>
            <ResizeHandle
              collapseToward="right"
              collapsed={rightCollapsed}
              onCollapseToggle={toggleRight}
              onDelta={adjustRight}
              onDragStart={onRightDragStart}
              onDragEnd={onDragEnd}
              dragging={dragging === 'h'}
            />
            {rightPanelOuter(rightColumnFilesOnly)}
          </div>
          <ResizeHandle
            direction="vertical"
            onDelta={adjustTerminalExpanded}
            onDragStart={() => setDragging('v')}
            onDragEnd={onDragEnd}
            dragging={dragging === 'v'}
          />
          <div dir={contentDirection} className="panel flex flex-col overflow-hidden" style={{ flex: terminalExpandedPct, minHeight: 0 }}>
            <Terminal onExpandToggle={toggleTerminalExpanded} expanded={terminalExpanded} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} dir="ltr" className="flex flex-1 min-h-0 p-3 overflow-hidden">
      {controlsContent}
      <ResizeHandle
        collapseToward="left"
        collapsed={leftCollapsed}
        onCollapseToggle={toggleLeft}
        onDelta={adjustLeft}
        onDragStart={onLeftDragStart}
        onDragEnd={onDragEnd}
        dragging={dragging === 'h'}
      />
      <div dir={contentDirection} className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
        {centerContent}
      </div>
      <ResizeHandle
        collapseToward="right"
        collapsed={rightCollapsed}
        onCollapseToggle={toggleRight}
        onDelta={adjustRight}
        onDragStart={onRightDragStart}
        onDragEnd={onDragEnd}
        dragging={dragging === 'h'}
      />
      {rightPanelOuter(rightColumnNormal)}
    </div>
  )
}
