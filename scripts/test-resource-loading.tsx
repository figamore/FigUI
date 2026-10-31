import assert from 'node:assert/strict'
import React from 'react'

const savedValues = new Map<string, string>()
const storage = {
  getItem: (key: string) => savedValues.get(key) ?? null,
  setItem: (key: string, value: string) => { savedValues.set(key, value) },
  removeItem: (key: string) => { savedValues.delete(key) },
}
Object.assign(globalThis, {
  localStorage: storage,
  sessionStorage: storage,
  window: Object.assign(new EventTarget(), {
    innerWidth: 1280, innerHeight: 800, location: { host: 'fluidnc.local' },
    matchMedia: () => ({ matches: false }),
  }),
  document: Object.assign(new EventTarget(), {
    documentElement: { classList: { add() {}, remove() {} } },
  }),
})

const { useMachineStore } = await import('../src/store')
const { useGCodeStore } = await import('../src/store/gcode')
const { useGCodeSenderStore } = await import('../src/store/gcodeSender')
const { parseGCode } = await import('../src/lib/gcode')
const { buildJobTimingEstimate, useJobRuntimeEstimate } = await import('../src/lib/jobRuntime')
const { Header } = await import('../src/components/Header')
const { setBase } = await import('../src/lib/http')
const { FileManager } = await import('../src/components/FileManager')
const { PluginLauncher } = await import('../src/components/PluginLauncher')
const { App } = await import('../src/App')
// App renders the controller job tracker beside AppContent; AppContent is the last child.
const appContent = () => [App().props.children].flat().at(-1).type
const { connect, disconnect } = await import('../src/lib/ws')
setBase('http://fluidnc.local')

// Run the real panel callbacks and effects with controlled hook state. Child
// components and DOM work are left unmounted; no browser or new dependency is
// needed to reproduce async request ordering and readiness transitions.
function panel(Component: any, effectFilter = (_effect: any) => true, mount = (_tree: any) => {}) {
  const slots: any[] = []
  let index = 0
  let effects: Array<() => void> = []
  const changed = (a: any[], b: any[]) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
  const memo = (fn: () => any, deps: any[]) => {
    const i = index++
    if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn(), deps }
    return slots[i].value
  }
  const dispatcher = {
    useState(initial: any) {
      const i = index++
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }]
    },
    useRef: (initial: any) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (fn: any, deps: any[]) => memo(() => fn, deps),
    useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
    useDebugValue() {},
    useContext: () => ({ innerWidth: 1280, innerHeight: 800, isCompactLandscape: false }),
    useEffect(effect: any, deps: any[]) {
      const i = index++
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i]
        slots[i] = { deps, cleanup: undefined }
        effects.push(() => {
          previous?.cleanup?.()
          if (effectFilter(effect)) slots[i].cleanup = effect()
        })
      }
    },
    useLayoutEffect(effect: any, deps: any[]) { this.useEffect(effect, deps) },
  }
  return {
    slots,
    render() {
      index = 0
      effects = []
      const current = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
      const previous = current.current
      current.current = dispatcher
      let tree
      try { tree = Component({}) } finally { current.current = previous }
      mount(tree)
      for (const effect of effects) effect()
      return tree
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return [tree]
  return [tree, ...nodes(tree.props?.children)]
}
const text = (tree: any) => nodes(tree).filter(node => typeof node === 'string').join(' ')
const find = (tree: any, predicate: (node: any) => boolean) => {
  const node = nodes(tree).find(node => node?.props && predicate(node))
  assert(node, 'Expected UI action was not present')
  return node
}
const ready = (value: boolean) => useMachineStore.setState({
  connected: true, statusReceived: true,
  status: { ...useMachineStore.getState().status, state: value ? 'Idle' : 'Run', sdFilename: value ? undefined : '/sd/job.nc' },
})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Resource loading did not settle')
}

const originalFetch = globalThis.fetch
try {
  // Navigation during motion must hide the old rows and fetch the requested
  // directory after motion. A refresh of that same cached path must also run.
  const paths: string[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    paths.push(url.searchParams.get('path')!)
    return new Response(JSON.stringify({ files: [{ name: `listing-${paths.length}.nc`, size: '12' }], path: paths.at(-1) }))
  }
  ready(true)
  const files = panel(FileManager)
  let tree = files.render()
  await waitFor(() => paths.length === 1)
  await tick()
  tree = files.render()
  const oldRow = find(tree, node => node.props.entry?.name === 'listing-1.nc')
  ready(false)
  files.render()
  oldRow.props.onNavigate('/sd/subdir/')
  tree = files.render()
  assert(!nodes(tree).some(node => node?.props?.entry), 'deferred navigation must clear the old listing')
  assert.equal(paths.length, 1, 'motion must defer the new listing request')
  ready(true)
  files.render()
  await waitFor(() => paths.length === 2)
  await tick()
  tree = files.render()
  const newRow = find(tree, node => node.props.entry?.name === 'listing-2.nc')
  assert.equal(newRow.props.path, '/sd/subdir/', 'file actions must use the directory that produced the listing')
  assert.deepEqual(paths, ['/', '/subdir/'])
  ready(false)
  tree = files.render()
  find(tree, node => node.props.title === 'Refresh').props.onClick()
  tree = files.render()
  assert(!nodes(tree).some(node => node?.props?.entry), 'deferred refresh must clear stale rows too')
  ready(true)
  files.render()
  await waitFor(() => paths.length === 3)
  await tick()
  tree = files.render()
  assert.equal(find(tree, node => node.props.entry?.name === 'listing-3.nc').props.path, '/sd/subdir/')
  assert.deepEqual(paths, ['/', '/subdir/', '/subdir/'], 'matching cached paths must not discard deferred refreshes')
  files.unmount()

  // Hold the first scan's icon fetch after its serialized filesystem reads.
  // This lets the second scan complete first, reproducing the overwrite race.
  let scans = 0
  const releases: Array<() => void> = []
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === '/files') {
      scans++
      return new Response(JSON.stringify({ files: [{ name: `scan-${scans}`, size: '-1' }], path: '/plugins' }))
    }
    if (url.pathname === '/upload') return new Response('{"files":[],"path":"/plugins"}')
    const number = Number(url.pathname.match(/scan-(\d+)/)?.[1])
    if (url.pathname.endsWith('plugin.json')) return new Response(JSON.stringify({
      name: number === 2 ? 'Newest plugin' : 'Stale plugin',
      ...(number === 2 ? {} : { icon: 'icon.svg' }),
    }))
    if (url.pathname.endsWith('icon.svg')) return new Promise<Response>(resolve => {
      releases.push(() => resolve(new Response('<svg/>')))
    })
    throw new Error(`Unexpected plugin request: ${url}`)
  }
  const plugins = panel(PluginLauncher)
  tree = plugins.render()
  await waitFor(() => releases.length === 1)
  tree = plugins.render()
  find(tree, node => node.props['aria-label'] === 'Refresh').props.onClick()
  await waitFor(() => scans === 2)
  await tick()
  await tick()
  assert.match(text(plugins.render()), /Newest plugin/)
  releases[0]()
  await tick()
  assert.match(text(plugins.render()), /Newest plugin/, 'older scan must not overwrite the current UI')
  assert.doesNotMatch(text(plugins.render()), /Stale plugin/)
  find(plugins.render(), node => node.props['aria-label'] === 'Refresh').props.onClick()
  await waitFor(() => releases.length === 2)
  ready(false)
  plugins.render()
  releases[1]()
  await tick()
  assert.match(text(plugins.render()), /Newest plugin/, 'readiness turning off must invalidate an active scan')
  plugins.unmount()
  const reopened = panel(PluginLauncher)
  assert.match(text(reopened.render()), /Newest plugin/, 'stale scans must not overwrite the module cache')
  reopened.unmount()

  // App restores the reported controller file only after a fresh status, and
  // percentage-only updates must not repeatedly rebuild that same preview.
  const restored: string[] = []
  const restoreRunningFile = useGCodeStore.getState().restoreRunningFile
  useGCodeStore.setState({ restoreRunningFile: async path => { restored.push(path) } })
  const runningApp = panel(appContent(), effect => effect.toString().includes('restoreRunningFile'))
  ready(false)
  useMachineStore.setState({ statusReceived: false })
  runningApp.render()
  assert.deepEqual(restored, [])
  useMachineStore.setState({ statusReceived: true })
  runningApp.render()
  assert.deepEqual(restored, ['/sd/job.nc'])
  useMachineStore.setState({ status: { ...useMachineStore.getState().status, sdPercent: 60.74 } })
  runningApp.render()
  assert.equal(restored.length, 1)
  useMachineStore.setState({ status: { ...useMachineStore.getState().status, sdFilename: '/sd/next.nc' } })
  runningApp.render()
  assert.deepEqual(restored, ['/sd/job.nc', '/sd/next.nc'])
  runningApp.unmount()
  useGCodeStore.setState({ restoreRunningFile })

  // Exercise App's real subscription effect before startupPending is true,
  // and again after pending changes; other App effects stay isolated here.
  class Socket {
    static OPEN = 1
    static CLOSED = 3
    static instance: Socket
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    constructor() { Socket.instance = this; queueMicrotask(() => this.onopen?.()) }
    send() {}
    close() { this.readyState = Socket.CLOSED }
  }
  Object.assign(globalThis, { WebSocket: Socket })
  await connect('fluidnc.local')
  useMachineStore.getState().setStartupPending(false)
  const app = panel(appContent(), effect => effect.toString().includes('Configuration error'))
  app.render()
  const firstError = '[MSG:ERR: Configuration error: first]'
  Socket.instance.onmessage?.({ data: `${firstError}\nok\n` })
  assert(app.slots.some(slot => Array.isArray(slot?.value) && slot.value.includes(firstError)), 'errors before resource startup must be captured')
  useMachineStore.getState().setStartupPending(true)
  app.render()
  useMachineStore.getState().setStartupPending(false)
  app.render()
  const secondError = '[MSG:ERR: Configuration error: second]'
  Socket.instance.onmessage?.({ data: `${secondError}\nok\n` })
  assert(app.slots.some(slot => Array.isArray(slot?.value) && slot.value.includes(secondError)), 'subscription must survive startupPending changes and previous batches')
  app.unmount()
  disconnect()

  // A full-layout plugin unmounts the Viewer, but the Header stays mounted.
  // Its clock must follow local jobs through holds while the Viewer is away.
  const originalNow = Date.now
  const originalSetInterval = window.setInterval
  const originalClearInterval = window.clearInterval
  let now = 1_000_000
  let nextTimer = 1
  const timers = new Map<number, () => void>()
  Date.now = () => now
  window.setInterval = ((fn: () => void) => {
    const id = nextTimer++
    timers.set(id, fn)
    return id
  }) as typeof window.setInterval
  window.clearInterval = id => { timers.delete(id) }
  const advance = (ms: number) => {
    now += ms
    for (const tick of [...timers.values()]) tick()
  }
  try {
    const model = parseGCode('G21 G90\nG1 X1000 F600')
    const settings = { maxRateX: 3000, maxRateY: 3000, maxRateZ: 1000, accelX: 200, accelY: 200, accelZ: 100 }
    useMachineStore.setState({
      status: { ...useMachineStore.getState().status, state: 'Run', sdFilename: undefined, sdPercent: undefined, feedOverride: 100, rapidOverride: 100 },
      controllerSettings: { ...useMachineStore.getState().controllerSettings, ...settings },
    })
    useGCodeStore.setState({ model, loadedPath: null, fileName: 'local.nc' })
    useGCodeSenderStore.setState({ phase: 'streaming', jobId: 100, fileName: 'local.nc' })
    const header = panel(Header)
    const viewer = () => panel(() => useJobRuntimeEstimate(
      useMachineStore.getState().status, model, useMachineStore.getState().controllerSettings, null, 'local.nc',
      { active: true, key: `${useGCodeSenderStore.getState().jobId}|local.nc` },
    ))
    header.render()
    let currentViewer = viewer()
    currentViewer.render()
    advance(4000)
    assert.equal(currentViewer.render().elapsedSeconds, 4)

    for (const state of ['Hold', 'Door'] as const) {
      currentViewer.unmount()
      useMachineStore.setState({ status: { ...useMachineStore.getState().status, state } })
      header.render()
      advance(30_000)
      currentViewer = viewer()
      const held = currentViewer.render()
      assert.equal(held.elapsedSeconds, 4, `${state} while the Viewer is unmounted must not count as running time`)
      const total = buildJobTimingEstimate(model, settings)!.totalSeconds
      assert.ok(Math.abs(held.remainingSeconds - (total - 4)) < 0.01, `${state} must preserve remaining time`)
    }

    currentViewer.unmount()
    useMachineStore.setState({ status: { ...useMachineStore.getState().status, state: 'Run' } })
    header.render()
    advance(2000)
    currentViewer = viewer()
    assert.equal(currentViewer.render().elapsedSeconds, 6, 'running time continues while the Viewer is unmounted')
    currentViewer.unmount()

    useGCodeSenderStore.setState({ phase: 'completed' })
    useMachineStore.setState({ status: { ...useMachineStore.getState().status, state: 'Idle' } })
    header.render()
    useGCodeSenderStore.setState({ phase: 'streaming', jobId: 101 })
    useMachineStore.setState({ status: { ...useMachineStore.getState().status, state: 'Run' } })
    header.render()
    currentViewer = viewer()
    assert.equal(currentViewer.render().elapsedSeconds, 0, 'the next local job starts a fresh clock')
    currentViewer.unmount()
    useGCodeSenderStore.setState({ phase: 'idle' })
    useMachineStore.setState({ status: { ...useMachineStore.getState().status, state: 'Idle' } })
    header.render()
    header.unmount()
  } finally {
    Date.now = originalNow
    window.setInterval = originalSetInterval
    window.clearInterval = originalClearInterval
    useGCodeSenderStore.setState({ phase: 'idle' })
  }
  {
    // Exercise the real viewer with a canvas stub and animation clock. A large
    // cached layer must sharpen during playback even when every frame redraws it.
    const { GCodeViewer } = await import('../src/components/GCodeViewer')
    const { buildRenderLines, buildStatic2DPaths } = await import('../src/lib/gcodeBuild')
    class TestPath {
      arcs = 0
      moveTo() {}
      lineTo() {}
      arc() { this.arcs++ }
    }
    let now = 0
    let nextId = 1
    const frames = new Map<number, FrameRequestCallback>()
    const timeouts = new Map<number, { at: number; fn: () => void }>()
    Object.assign(globalThis, {
      Path2D: TestPath,
      WheelEvent: { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
      requestAnimationFrame: (fn: FrameRequestCallback) => { const id = nextId++; frames.set(id, fn); return id },
      cancelAnimationFrame: (id: number) => { frames.delete(id) },
      ResizeObserver: class { observe() {} disconnect() {} },
    })
    window.setTimeout = ((fn: () => void, ms = 0) => {
      const id = nextId++
      timeouts.set(id, { at: now + ms, fn })
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = id => { timeouts.delete(id) }
    window.setInterval = (() => nextId++) as typeof window.setInterval
    window.clearInterval = () => {}
    const frame = () => {
      now += 16
      for (const [id, timer] of [...timeouts]) {
        if (timer.at <= now) { timeouts.delete(id); timer.fn() }
      }
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(now)
    }
    let layerStrokes = 0
    let rings = 0
    let completedDots = 0
    const context = (offscreen: boolean) => new Proxy({
      stroke(path?: TestPath) { if (offscreen) layerStrokes++; rings += path?.arcs ?? 0 },
      fill(path?: TestPath) { completedDots += path?.arcs ?? 0 },
      createRadialGradient: () => ({ addColorStop() {} }),
    } as any, { get: (target, key) => key in target ? target[key] : () => {} })
    const element = (offscreen = false) => Object.assign(new EventTarget(), {
      width: 800, height: 600, clientWidth: 800, clientHeight: 600, style: {},
      getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      getContext: () => context(offscreen),
    })
    document.createElement = (() => element(true)) as any
    const container = element()
    const canvas = element()
    const mount = (tree: any) => {
      for (const node of nodes(tree)) {
        if (node?.ref && typeof node.ref === 'object') {
          node.ref.current = node.type === 'canvas' ? canvas : container
        }
      }
    }
    ready(true)
    useGCodeStore.getState().clear()
    const source = 'G21 G90\nG0 Z2\nG0 X10 Y10\nG1 Z-2 F60\nG1 X1000 F60'
    const viewerModel = parseGCode(source)
    const lines = buildRenderLines(viewerModel.segments)
    useGCodeStore.setState({
      model: viewerModel, sourceText: source, fileName: 'viewer.nc', loadedPath: '/sd/viewer.nc',
      paths2D: buildStatic2DPaths(lines),
      // Only the count controls the large-layer strategy; the paths stay small.
      renderLines: { ...lines, count: 100_001 },
      trackedJob: null, showPlunges: true,
    })
    const viewer = panel(GCodeViewer, () => true, mount)
    let viewerTree = viewer.render()
    frame() // fit
    frame() // stroke the initial layer
    assert(layerStrokes > 0)
    assert(rings > 0, 'vertical plunges initially have rings')

    const plungeToggle = () => find(viewerTree, node => node.props.title?.startsWith('Toggle plunge markers'))
    plungeToggle().props.onClick()
    viewerTree = viewer.render()
    rings = 0
    frame()
    assert.equal(plungeToggle().props['aria-pressed'], false)
    assert.equal(storage.getItem('gcode.showPlunges'), 'false', 'the visibility choice is saved')
    assert.equal(rings, 0, 'hiding plunges invalidates the layer and removes its rings')
    plungeToggle().props.onClick()
    viewerTree = viewer.render()
    rings = 0
    frame()
    assert(rings > 0, 'plunge rings can be shown again')

    find(viewerTree, node => node.props.title === 'Toggle tool position marker').props.onClick()
    viewerTree = viewer.render()
    find(viewerTree, node => node.type === 'button' && text(node).trim() === 'Simulate').props.onClick()
    viewerTree = viewer.render()
    frame()
    const beforeZoom = layerStrokes
    const wheel = new Event('wheel', { cancelable: true })
    Object.assign(wheel, { deltaY: -200, deltaMode: 0, clientX: 400, clientY: 300 })
    container.dispatchEvent(wheel)
    frame()
    assert.equal(layerStrokes, beforeZoom, 'zoom initially reuses the large bitmap')
    for (let i = 0; i < 15; i++) frame()
    assert(layerStrokes > beforeZoom, 'continuous simulation frames must not postpone the sharp redraw')

    // Jump to the final, long segment so the first plunge is completed. Both
    // the static rings and the green progress dots obey the same toggle.
    const originalPerformance = globalThis.performance
    Object.assign(globalThis, { performance: { now: () => originalPerformance.now() + 10_000 } })
    try { frame() } finally { Object.assign(globalThis, { performance: originalPerformance }) }
    viewerTree = viewer.render()
    completedDots = 0
    frame()
    assert(completedDots > 0, 'simulation fills completed plunge markers')
    plungeToggle().props.onClick()
    viewerTree = viewer.render()
    rings = 0
    completedDots = 0
    frame()
    assert.equal(rings, 0, 'hidden rings stay hidden during simulation')
    assert.equal(completedDots, 0, 'completed plunge dots are hidden too')
    viewer.unmount()
    frames.clear()
    timeouts.clear()

    // A config macro must never leave a file-loading notice after it ends.
    // Mounted files with the same name still retain the normal Load action.
    for (const program of ['after_homing', 'after_reset', 'after_unlock', 'Macro0', '/sd/after_homing']) {
      useMachineStore.setState({ status: { ...useMachineStore.getState().status, state: 'Run', sdFilename: program } })
      const notice = panel(GCodeViewer)
      notice.render()
      let noticeTree = notice.render()
      const realFile = program.startsWith('/sd/')
      assert.equal(text(noticeTree).includes('from another window or device'), realFile, program)
      ready(true)
      noticeTree = notice.render()
      assert.equal(nodes(noticeTree).some(node => node?.type === 'button' && text(node).trim() === 'Load'), realFile, `${program}: Load after completion`)
      notice.unmount()
      frames.clear()
    }
  }
  console.log('Resource loading, viewer zoom, plunge visibility, and macro notice checks passed')
} finally {
  disconnect()
  globalThis.fetch = originalFetch
}
