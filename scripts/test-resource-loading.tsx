import assert from 'node:assert/strict'
import React from 'react'

const storage = { getItem: () => null, setItem() {} }
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
const { setBase } = await import('../src/lib/http')
const { FileManager } = await import('../src/components/FileManager')
const { PluginLauncher } = await import('../src/components/PluginLauncher')
const { App } = await import('../src/App')
const { connect, disconnect } = await import('../src/lib/ws')
setBase('http://fluidnc.local')

// Run the real panel callbacks and effects with controlled hook state. Child
// components and DOM work are left unmounted; no browser or new dependency is
// needed to reproduce async request ordering and readiness transitions.
function panel(Component: any, effectFilter = (_effect: any) => true) {
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
  const app = panel((App().props.children as any).type, effect => effect.toString().includes('Configuration error'))
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
  console.log('Deferred file listings, plugin scan ordering, and configuration error checks passed')
} finally {
  disconnect()
  globalThis.fetch = originalFetch
}
