import assert from 'node:assert/strict'
import { readLanguages, enabledLanguages } from './languages.mjs'
import { translateJsx } from './translate-jsx.mjs'

const languages = readLanguages()
for (const code of ['en', 'es', 'fr', 'pt', 'de', 'ru', 'ar', 'hi', 'tr', 'ja', 'zh-Hans', 'it', 'pl', 'ko', 'uk', 'bg']) assert(languages.some(language => language.code === code))
assert(enabledLanguages().some(language => language.code === 'en'))
assert(enabledLanguages().some(language => language.code === 'es'))
for (const language of enabledLanguages()) assert.doesNotThrow(() => translateJsx(language.code))
assert.equal(languages.find(language => language.code === 'ar').direction, 'rtl')
assert(languages.filter(language => !language.enabled).every(language => {
  assert.throws(() => translateJsx(language.code), /Unsupported UI locale/)
  return true
}))
console.log('Language registry and release-gate checks passed')
