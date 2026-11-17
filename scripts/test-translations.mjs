import assert from 'node:assert/strict'
import { translateJsx, validateCatalogs, parseCatalog, validateMessageUsage } from './translate-jsx.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const source = `const command = 'Stop'; const view = <button onClick={() => send('Stop')}>{__uiText('components.CodeEditor.cancel.1', 'Cancel')}</button>`
const plugin = translateJsx('es')
// The selected key comes from the actual catalog rather than English text.
const result = plugin.transform(source, '/project/src/App.tsx').code
assert.match(result, /"Cancelar"/)
assert.match(result, /send\('Stop'\)/)
assert.match(result, /command = 'Stop'/)
assert.throws(() => plugin.transform(`__uiText('missing.key', 'Cancel')`, '/project/src/App.tsx'), /unknown translation key/)
assert.throws(() => plugin.transform(`__uiText('components.CodeEditor.cancel.1', 'Changed')`, '/project/src/App.tsx'), /English text differs/)
assert.throws(() => validateCatalogs({ a: 'Hello {name}' }, { a: 'Hola' }), /placeholders differ/)
assert.throws(() => validateCatalogs({ a: 'Hello' }, {}), /Missing translation/)
assert.throws(() => validateCatalogs({}, { a: 'Hola' }), /Unknown translation/)
assert.throws(() => translateJsx('zz-ZZ'), /Unsupported UI locale/)
assert.throws(() => parseCatalog('es', '{"key":"uno","key":"dos"}'), /duplicate translation key/)
assert.throws(() => parseCatalog('es', '{"key":""}'), /invalid translation/)
const temporary = mkdtempSync(join(tmpdir(), 'figui-i18n-test-'))
try {
  writeFileSync(join(temporary, 'example.ts'), `__uiText('screen.key.1', 'Save'); __uiText('screen.key.1', 'Save')`)
  assert.throws(() => validateMessageUsage({ 'screen.key.1': 'Save' }, temporary), /used twice/)
  writeFileSync(join(temporary, 'example.ts'), '')
  assert.throws(() => validateMessageUsage({ 'screen.key.1': 'Save' }, temporary), /Unused translation/)
} finally { rmSync(temporary, { recursive: true, force: true }) }
assert.match(plugin.transformIndexHtml('<html lang="en">'), /lang="es"/)
console.log('Translation build checks passed')
