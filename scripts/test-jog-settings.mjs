import assert from 'node:assert/strict'
import { build } from 'esbuild'

const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
globalThis.document = {
  documentElement: { classList: { add() {}, remove() {} } },
}

const bundle = await build({
  stdin: {
    contents: `
      export { useMachineStore } from './src/store'
      export { updateControllerConfigSetting } from './src/lib/controllerConfig'
      export { buildLimitedFeedPresets, getJogFeedMax } from './src/lib/jog'
      export { parseControllerSettingLine } from './src/lib/parser'
      export { TabletJogPad } from './src/components/JogPad'
      export { axisStepToCommand } from './src/lib/units'
      export { createElement } from 'react'
      export { renderToStaticMarkup } from 'react-dom/server.browser'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
})
const {
  useMachineStore: store,
  updateControllerConfigSetting,
  buildLimitedFeedPresets,
  getJogFeedMax,
  parseControllerSettingLine,
  TabletJogPad,
  axisStepToCommand,
  createElement,
  renderToStaticMarkup,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

const presets = [50, 100, 200, 500, 1000, 2000, 3000]
const rates = { X: 5000, Y: 4000, Z: 1500, A: 900, B: 600, C: 300 }
const setting = (P, V) => ({ P, V: String(V), T: 'R' })
const tree = Object.entries(rates).map(([axis, rate]) =>
  setting(`/AXES/${axis}/max_rate_mm_per_min`, rate),
)
const grbl = Object.entries(rates).map(([axis, rate]) =>
  setting(`Grbl/MaxRate/${axis}`, rate),
)

for (const initial of [tree, grbl, [...tree, ...grbl]]) {
  store.setState({ controllerSettings: {}, controllerConfigSettings: null })
  store.getState().setControllerConfigSettings(initial)
  const groupPresets = (group, axes = 6) => buildLimitedFeedPresets(
    presets, getJogFeedMax(store.getState().controllerSettings, group, axes),
  )
  assert.equal(groupPresets('xy').at(-1), 4000)
  assert.equal(groupPresets('z').at(-1), 1500)
  assert.equal(groupPresets('abc').at(-1), 300)
  assert.equal(groupPresets('abc', 4).at(-1), 900)
  assert.equal(groupPresets('abc', 5).at(-1), 600)

  // The same cache update used after a successful Settings save must notify
  // existing jog-control subscribers without reconnecting or reloading.
  let observedPresets
  const unsubscribe = store.subscribe(() => {
    observedPresets = ['xy', 'z', 'abc'].map(group => groupPresets(group))
  })
  function save(axis, value, useGrbl = false) {
    const state = store.getState()
    const path = useGrbl || initial === grbl
      ? `Grbl/MaxRate/${axis}`
      : `/AXES/${axis}/max_rate_mm_per_min`
    state.setControllerConfigSettings(
      updateControllerConfigSetting(state.controllerConfigSettings, path, String(value)),
    )
  }

  save('Y', 750)
  save('Z', 75)
  save('C', 125)
  assert.deepEqual(observedPresets, [
    [50, 100, 200, 500, 750], [50, 75], [50, 100, 125],
  ])
  save('Y', 6000)
  save('Z', 4500)
  save('C', 1200)
  assert.deepEqual(observedPresets.map(values => values.at(-1)), [5000, 4500, 600])

  if (initial.length === tree.length + grbl.length) {
    // Saving either alias must not leave a stale copy overriding the new rate.
    save('Z', 250, true)
    assert.deepEqual(groupPresets('z'), [50, 100, 200, 250])
    const aliases = store.getState().controllerConfigSettings.filter(s =>
      s.P === 'Grbl/MaxRate/Z' || s.P === '/AXES/Z/max_rate_mm_per_min',
    )
    assert.ok(aliases.every(s => s.V === '250'))
  }
  unsubscribe()
}

assert.equal(getJogFeedMax({}, 'abc'), undefined)
assert.equal(getJogFeedMax({ maxRateA: 0, maxRateB: NaN, maxRateC: 400 }, 'abc'), 400)
assert.deepEqual(buildLimitedFeedPresets(presets, 25), [25])
for (const [number, axis] of [[113, 'A'], [114, 'B'], [115, 'C']]) {
  assert.deepEqual(parseControllerSettingLine(`$${number}=720.000`), { [`maxRate${axis}`]: 720 })
}

storage.set('jog.abcFeed', '350')
// Render each configured machine as the server snapshot used by Zustand.
const renderState = store.getInitialState()
for (const axes of [3, 4, 5, 6]) {
  for (const layout of ['default', 'topBand']) {
    store.setState({ axes, units: 'in', status: { ...store.getState().status, state: 'Idle' } })
    Object.assign(renderState, store.getState())
    const html = renderToStaticMarkup(createElement(TabletJogPad, { layout }))
    for (const [index, axis] of ['A', 'B', 'C'].entries()) {
      for (const direction of ['negative', 'positive']) {
        assert.equal(html.includes(`aria-label="Jog ${axis} ${direction}"`), index < axes - 3)
      }
    }
    assert.equal(html.includes('aria-label="Set ABC feedrate"'), axes > 3)
    assert.equal(html.includes('class="jog-rotary-controls"'), axes > 3)
    assert.ok(!html.split('class="jog-rotary-controls"')[0].includes('aria-label="Jog A'))
    if (axes > 3) assert.match(html, />350<\/span><span[^>]*>mm\/min/)
  }
}
store.setState({ axes: 6, status: { ...store.getState().status, state: 'Run' } })
Object.assign(renderState, store.getState())
const busyHtml = renderToStaticMarkup(createElement(TabletJogPad))
assert.match(busyHtml, /disabled="" aria-label="Jog A positive"/)
// Rotary distances must stay in degrees even with an inch display.
for (const axis of ['A', 'B', 'C']) assert.equal(axisStepToCommand(1, axis, 'in'), 1)
assert.equal(axisStepToCommand(1, 'X', 'in'), 25.4)

console.log('Jog settings and compact controls passed for three through six axes.')
