import assert from 'node:assert/strict'
import vm from 'node:vm'
import { packEsp32Html } from './pack-esp32.mjs'

async function unpack(html) {
  const loader = html.match(/<script\b[^>]*data-figui-packed[^>]*>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(loader, 'packed module is present')
  const root = { textContent: '' }
  let removed = false
  const errors = []
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Loader did not finish')), 5000)
    const packedScript = {
      attributes: [
        { name: 'type', value: 'module' },
        { name: 'crossorigin', value: '' },
        { name: 'nonce', value: '' },
        { name: 'data-figui-packed', value: '' },
      ],
      nonce: 'test-nonce',
      after(script) {
        assert.equal(script.type, 'module')
        assert.equal(script.nonce, 'test-nonce')
        assert.equal(script['data-figui-packed'], undefined)
        assert.equal(script.crossorigin, '')
        assert.equal(removed, false, 'insert the restored module before removing the loader')
        clearTimeout(timeout)
        resolve(script.textContent)
      },
      remove() { removed = true },
    }
    const context = {
      setTimeout, clearTimeout, atob, Uint8Array,
      console: { error: (...args) => {
        errors.push(args)
        clearTimeout(timeout)
        resolve(null)
      } },
      document: {
        createElement(tag) {
          assert.equal(tag, 'script')
          return { setAttribute(name, value) { this[name] = value } }
        },
        querySelector(selector) {
          assert.equal(selector, 'script[data-figui-packed]')
          return packedScript
        },
        getElementById(id) { assert.equal(id, 'root'); return root },
      },
    }
    context.window = { document: context.document }
    vm.runInNewContext(loader, context)
    assert.equal(context.LZMA, undefined, 'decoder must not leak browser globals')
  })
  return { source: result, removed, errors, root }
}

const source = `
  const unicode = 'Café — 中文 🛠️';
  const literal = '$& $\u0060 $\u0027';
  const template = \`line one\nline two\`;
  const escapedEnd = '<\\/script>';
  await Promise.resolve();
  export { unicode, literal, template, escapedEnd };
`
const prefix = '<!doctype html><html><head><style>body{color:red}</style>'
const suffix = '</head><body><div id="root"></div><script>/* other script */</script></body></html>'
const html = `${prefix}<script type="module" crossorigin nonce="test-nonce">${source}</script>${suffix}`
const packed = await packEsp32Html(html)
assert.ok(packed.startsWith(prefix))
assert.ok(packed.endsWith(suffix))
assert.ok(packed.includes('nonce="test-nonce"'))
const loaded = await unpack(packed)
assert.equal(loaded.source, source, 'recover the exact original module, including Unicode')
assert.equal(loaded.removed, true, 'release the packed script without a load event')
assert.deepEqual(loaded.errors, [])

// A damaged download produces a visible error, not a silent blank screen.
const corrupt = packed.replace(/atob\("[A-Za-z0-9+/=]+"\)/, 'atob("AA==")')
assert.notEqual(corrupt, packed)
const failed = await unpack(corrupt)
assert.equal(failed.source, null)
assert.equal(failed.errors.length, 1)
assert.match(failed.root.textContent, /Please reload/)

for (const invalid of [
  '<script>classic()</script>',
  '<script type="module" src="external.js"></script>',
  '<script type="module"></script>',
  '<script type="module">a()</script><script type="module">b()</script>',
]) {
  await assert.rejects(packEsp32Html(invalid))
}
console.log('ESP32 packer tests passed: exact module recovery, offline loader, cleanup and errors')
