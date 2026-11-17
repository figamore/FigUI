import assert from 'node:assert/strict'
import { build } from 'esbuild'

for (const locale of ['en', 'es']) {
  const result = await build({
    entryPoints: ['src/lib/language.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', define: { 'import.meta.env.VITE_FIGUI_LOCALE': JSON.stringify(locale) },
  })
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  assert.equal(module.UI_LANGUAGE, locale)
  assert.equal(module.firmwareUrl('1.2.3', locale), `https://figamore.github.io/FigUI/firmware/v1.2.3/index${locale === 'es' ? '.es' : ''}.html.gz`)
  for (const invalid of ['../1.2.3', '1.2.3/../../other', 'v1.2.3', '1.2.3-beta']) {
    assert.throws(() => module.firmwareUrl(invalid, locale))
  }
}
console.log('Language and versioned download checks passed')

// A future enabled language must select its own versioned artifact, while
// unregistered or path-like locale values must never reach the download URL.
const future = await build({
  entryPoints: ['src/lib/language.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', define: {
    'import.meta.env.VITE_FIGUI_LOCALE': '"zh-Hans"',
    '__FIGUI_LANGUAGES__': JSON.stringify([{ code: 'en', name: 'English' }, { code: 'zh-Hans', name: '简体中文' }]),
  },
})
const futureModule = await import(`data:text/javascript;base64,${Buffer.from(future.outputFiles[0].text).toString('base64')}`)
assert.equal(futureModule.UI_LANGUAGE, 'zh-Hans')
assert.match(futureModule.firmwareUrl('1.2.3', 'zh-Hans'), /\/v1\.2\.3\/index\.zh-Hans\.html\.gz$/)
assert.throws(() => futureModule.firmwareUrl('1.2.3', '../es'))
assert.throws(() => futureModule.firmwareUrl('1.2.3', 'fr'))
