import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCatalog, parsePluralCatalog, validateCatalogs, validatePluralCatalogs } from './translate-jsx.mjs'

// Validate every translated catalog independently of the selected build locale.
const read = name => readFileSync(new URL(`../locales/${name}.json`, import.meta.url), 'utf8')
const locales = JSON.parse(read('languages')).map(language => language.code)
const english = parseCatalog('en', read('en'))
const englishPlurals = parsePluralCatalog('plurals.en', read('plurals.en'))
for (const locale of locales) {
  const catalog = parseCatalog(locale, read(locale))
  const plurals = parsePluralCatalog(`plurals.${locale}`, read(`plurals.${locale}`))
  assert.doesNotThrow(() => validateCatalogs(english, catalog), `${locale}: invalid catalog`)
  assert.doesNotThrow(() => validatePluralCatalogs(englishPlurals, plurals, locale), `${locale}: invalid plural catalog`)
}
console.log('Translated catalogs have valid keys, placeholders and plural forms')
