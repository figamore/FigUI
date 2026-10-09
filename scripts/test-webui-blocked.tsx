import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { WebUIBlocked } from '../src/components/WebUIBlocked'

const storage = { getItem: () => null, setItem: () => {} }
Object.assign(globalThis, {
  localStorage: storage,
  sessionStorage: storage,
  document: Object.assign(new EventTarget(), { documentElement: { classList: { add() {}, remove() {} } } }),
  window: new EventTarget(),
})

const { getDeviceInfo, getDeviceInfoFast, setBase, WebUIBlockedError } = await import('../src/lib/http')
setBase('http://fluidnc.local')
const originalFetch = globalThis.fetch

try {
  for (const discover of [getDeviceInfo, getDeviceInfoFast]) {
    for (const body of [
      'Try again when not moving\n',
      '<h3>Cannot load WebUI while GCode Program is Running</h3>',
    ]) {
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        assert.equal(url.origin, 'http://fluidnc.local')
        assert.equal(url.pathname, '/command')
        assert.equal(url.searchParams.get('cmd'), '[ESP800]json=yes')
        assert.equal(url.searchParams.has('plain'), false)
        assert.equal(init?.cache, 'no-store')
        return new Response(body, { status: 503 })
      }
      await assert.rejects(discover(), WebUIBlockedError)
    }

    // Unrelated service failures must retain the regular connection error.
    for (const status of [401, 404, 500, 503]) {
      globalThis.fetch = async () => new Response('Service unavailable', { status })
      await assert.rejects(discover(), error =>
        error instanceof Error && !(error instanceof WebUIBlockedError) && error.message === `HTTP ${status}`,
      )
    }

    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    await assert.rejects(discover(), /Failed to fetch/)

    // Model FluidNC's whitelist: cmd discovery succeeds during motion while
    // the plain command path is still blocked.
    const info = JSON.stringify({ data: { WebCommunication: 'Synchronous' } })
    globalThis.fetch = async input => new URL(String(input)).searchParams.has('plain')
      ? new Response('Try again when not moving\n', { status: 503 })
      : new Response(info)
    assert.equal(await discover(), info)
  }

  const screen = WebUIBlocked({ base: 'http://fluidnc.local', onReload() {} })
  const markup = renderToStaticMarkup(screen)
  assert.match(markup, /Cannot load WebUI while GCode Program is Running/)
  assert.match(markup, /href="http:\/\/fluidnc\.local\/feedhold_reload"[^>]*>Pause<\/a>/)
  assert.match(markup, /href="http:\/\/fluidnc\.local\/restart_reload"[^>]*>Stop<\/a>/)
  assert.match(markup, /Pause the GCode program with feedhold/)
  assert.match(markup, /Stop the GCode Program with reset/)
  assert.match(markup, /Reload WebUI/)
  assert.match(markup, /You must first stop the GCode program or wait for it to finish/)
  assert.doesNotMatch(markup, /Could not connect|HTTP 503/)

  const { useMachineStore } = await import('../src/store')
  const { connect, disconnect, sendRealtimeNow, sendStartupQueries } = await import('../src/lib/ws')
  const { scheduleControllerStartup } = await import('../src/lib/controllerResources')
  const { loadControllerConfigSettings } = await import('../src/lib/controllerConfig')
  const { loadMacroCfg, listFiles } = await import('../src/lib/http')
  const { Header } = await import('../src/components/Header')
  const { JobControl } = await import('../src/components/JobControl')
  const { useGCodeStore } = await import('../src/store/gcode')
  // SSR uses Zustand's initial snapshot. Copy the live report into that server
  // snapshot before rendering so these checks exercise the actual UI widgets.
  const renderHeader = () => {
    Object.assign(useMachineStore.getInitialState(), useMachineStore.getState())
    return renderToStaticMarkup(<Header onSettingsClick={() => {}} onAboutClick={() => {}} />)
  }

  class TestSocket {
    static OPEN = 1
    static CLOSED = 3
    static instance: TestSocket
    readyState = 1
    binaryType = ''
    onopen: (() => void) | null = null
    onclose = null
    onerror = null
    onmessage: ((event: { data: string }) => void) | null = null
    sent: Array<string | Uint8Array> = []
    constructor() {
      TestSocket.instance = this
      queueMicrotask(() => this.onopen?.())
    }
    send(data: string | Uint8Array) { this.sent.push(data) }
    close() { this.readyState = TestSocket.CLOSED }
    report(state: string, file = '') {
      this.onmessage?.({ data: `<${state}|MPos:0,0,0|FS:0,0${file ? `|SD:30,${file}` : ''}>\n` })
    }
  }
  Object.assign(globalThis, { WebSocket: TestSocket })

  const requests: string[] = []
  const reply = (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const command = url.searchParams.get('plain')
    requests.push(command ?? url.pathname)
    if (command === '$SS') return new Response('[MSG:INFO: Probe Pin: gpio.34]\nok\n')
    if (command === '$$') return new Response('$13=0\nok\n')
    if (command === '[ESP400]') return new Response('{"EEPROM":[{"P":"Hostname","T":"S","V":"fluidnc","H":"Hostname"}]}')
    if (url.pathname === '/macrocfg.json') return new Response('[]')
    if (url.pathname === '/files') return new Response('{"files":[],"path":"/"}')
    throw new Error(`Unexpected startup request: ${url}`)
  }
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Startup did not settle')
  }
  const start = () => scheduleControllerStartup(async canContinue => {
    if (!await sendStartupQueries(canContinue)) return false
    await loadControllerConfigSettings(true)
    if (!canContinue()) return false
    await loadMacroCfg()
    if (!canContinue()) return false
    await listFiles('/', 'local')
    return canContinue()
  }, useMachineStore.getState().setStartupPending)
  const expected = ['$SS', '$$', '[ESP400]', '/macrocfg.json', '/files']
  let stopStartup = () => {}
  try {
    globalThis.fetch = async input => reply(input)
    await connect('fluidnc.local')
    stopStartup = start()
    assert.equal(useMachineStore.getState().statusReceived, false)
    assert.equal(useMachineStore.getState().status.state, 'Unknown')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, [], 'socket open alone must not start resource loading')

    const socket = TestSocket.instance
    socket.report('Run', '/sd/job.nc')
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.equal(useMachineStore.getState().statusReceived, true)
    assert.equal(useMachineStore.getState().status.sdFilename, '/sd/job.nc')
    assert.deepEqual(requests, [], 'a running job must not trigger startup HTTP')
    assert(socket.sent.some(data => data instanceof Uint8Array && data[0] === 0x3f), 'live status polling must continue')
    assert.equal(sendRealtimeNow(0x21), true, 'feedhold must remain available')

    socket.onmessage?.({ data: '<Run|MPos:-7.131,-1.253,-6.000,0.000,0.000|FS:924,5000|Pn:P|SD:60.74,/littlefs/multi-tool-demo-3.nc>' })
    assert.equal(useGCodeStore.getState().model, null, 'reload has no preview model')
    assert.equal(useMachineStore.getState().status.sdPercent, 60.74)
    assert.match(renderHeader(), /60\.74%/, 'header must show live progress without a preview or settings')
    assert.match(renderHeader(), /width:60\.74%/, 'header bar must use the reported percentage')
    const jobMarkup = renderToStaticMarkup(<JobControl />)
    assert.match(jobMarkup, /File .*60\.74%/, 'job controls must show the controller percentage')
    assert.doesNotMatch(jobMarkup, /Elapsed|Remain|Total/, 'reload must not invent a timing estimate')
    assert.deepEqual(requests, [], 'showing progress must not fetch the running file')
    socket.report('Hold:0', '/sd/job.nc')
    socket.report('Idle', '/sd/job.nc')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, [], 'paused jobs and Idle between file blocks must stay deferred')

    socket.report('Idle')
    assert.doesNotMatch(renderHeader(), /60\.74%/, 'completed jobs must clear the live progress display')
    await waitFor(() => requests.length === expected.length && !useMachineStore.getState().startupPending)
    assert.deepEqual(requests, expected, 'deferred resources must load automatically when the job finishes')
    socket.report('Idle')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, expected, 'status reports must not repeat completed startup')
    stopStartup()
    disconnect()

    // A short job can start and finish while $SS is in flight. Its old response
    // must not apply settings or continue into the next startup request.
    requests.length = 0
    useMachineStore.setState({ controllerSettings: {} })
    let release: (() => void) | undefined
    globalThis.fetch = async input => {
      const response = reply(input)
      if (requests.length === 1) return new Promise<Response>(resolve => { release = () => resolve(response) })
      return response
    }
    await connect('fluidnc.local')
    stopStartup = start()
    TestSocket.instance.report('Idle')
    await waitFor(() => release !== undefined)
    TestSocket.instance.report('Run', '/sd/new-job.nc')
    TestSocket.instance.report('Idle')
    release!()
    await waitFor(() => requests.length === expected.length + 1 && !useMachineStore.getState().startupPending)
    assert.deepEqual(requests, ['$SS', ...expected], 'interrupted startup must restart after motion finishes')
    stopStartup()
    disconnect()

    // Disconnect before the pending HTTP response arrives; reconnecting must
    // wait for new status rather than use the previous connection's Idle state.
    requests.length = 0
    release = undefined
    await connect('fluidnc.local')
    stopStartup = start()
    TestSocket.instance.report('Idle')
    await waitFor(() => release !== undefined)
    disconnect()
    stopStartup()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, ['$SS'], 'disconnected startup must not continue into settings or files')
    globalThis.fetch = async input => reply(input)
    await connect('fluidnc.local')
    stopStartup = start()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, ['$SS'], 'reconnect must wait for fresh status')
    TestSocket.instance.report('Run', '/sd/job.nc')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(requests, ['$SS'])
    TestSocket.instance.report('Idle')
    await waitFor(() => requests.length === expected.length + 1 && !useMachineStore.getState().startupPending)
    assert.deepEqual(requests, ['$SS', ...expected])
    stopStartup()

    // Returning false while readiness stays true must be terminal. The pending
    // flag writes back to the subscribed store, so an immediate retry would
    // otherwise keep this promise chain alive forever.
    let falseLoads = 0
    stopStartup = scheduleControllerStartup(async () => {
      falseLoads++
      if (falseLoads > 1) throw new Error('Unsuccessful startup was retried')
      return false
    }, useMachineStore.getState().setStartupPending)
    await waitFor(() => falseLoads > 0 && !useMachineStore.getState().startupPending)
    TestSocket.instance.report('Idle')
    useMachineStore.getState().setStartupPending(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(falseLoads, 1, 'false completion must not retry on pending or status updates')
  } finally {
    stopStartup()
    disconnect()
  }
  console.log('WebUI discovery, motion-aware startup, and recovery checks passed')
} finally {
  globalThis.fetch = originalFetch
}
