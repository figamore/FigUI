import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { WebUIBlocked } from '../src/components/WebUIBlocked'

const storage = { getItem: () => null, setItem: () => {} }
Object.assign(globalThis, {
  localStorage: storage,
  sessionStorage: storage,
  document: { documentElement: { classList: { add() {}, remove() {} } } },
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
      globalThis.fetch = async input => {
        const url = new URL(String(input))
        assert.equal(url.origin, 'http://fluidnc.local')
        assert.equal(url.pathname, '/command')
        assert.equal(url.searchParams.get('plain'), '[ESP800]json=yes')
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

    // Reload can discover the controller once motion has finished.
    const info = JSON.stringify({ data: { WebCommunication: 'Synchronous' } })
    globalThis.fetch = async () => new Response(info)
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
  console.log('WebUI motion-blocked recovery checks passed')
} finally {
  globalThis.fetch = originalFetch
}
