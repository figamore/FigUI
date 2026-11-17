import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { parsePluralCatalog, validatePluralCatalogs } from './translate-jsx.mjs'

async function load(locale) {
  const result = await build({ entryPoints: ['src/lib/i18n.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', define: { __FIGUI_LOCALE__: JSON.stringify(locale) } })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const forms = { zero: 'zero {count}', one: 'one {count}', two: 'two {count}', few: 'few {count}', many: 'many {count}', other: 'other {count}' }
const ru = await load('ru')
assert.equal(ru.uiPlural('k', 1, forms), 'one 1')
assert.equal(ru.uiPlural('k', 2, forms), 'few 2')
assert.equal(ru.uiPlural('k', 5, forms), 'many 5')
assert.equal(ru.uiPlural('k', 21, forms), 'one 21')
const ar = await load('ar')
for (const [count, category] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']]) {
  assert.equal(ar.uiPlural('k', count, forms), `${category} ${count}`)
}
assert.throws(() => parsePluralCatalog('x', '{"k":{"one":"a","one":"b"}}'), /duplicate or invalid/)
assert.throws(() => validatePluralCatalogs({ k: { other: '{count} x' } }, { k: { one: '{count} x', other: '{count} x' } }, 'ru'), /Missing plural form/)
assert.throws(() => validatePluralCatalogs({ k: { other: '{count} x' } }, { k: { one: 'wrong', other: '{count} x' } }, 'en'), /Invalid plural translation/)
console.log('Locale-specific plural checks passed')
