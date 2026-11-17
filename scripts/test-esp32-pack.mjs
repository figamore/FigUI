import assert from 'node:assert/strict'
import vm from 'node:vm'
import lzma from 'lzma'
import { gunzipSync } from 'node:zlib'
import { packEsp32Html, gzipSmallestHtml } from './pack-esp32.mjs'

async function unpack(html, expectedStyles = []) {
  const loader = html.match(/<script\b[^>]*data-figui-packed[^>]*>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(loader, 'packed module is present')
  const root = { textContent: '' }
  let removed = false
  const errors = []
  const styles = [...html.matchAll(/<style\b[^>]*data-figui-style="(\d+)"[^>]*>([\s\S]*?)<\/style>/g)]
    .map(match => ({
      index: Number(match[1]), textContent: match[2], removedMarker: false,
      removeAttribute(name) {
        assert.equal(name, 'data-figui-style')
        this.removedMarker = true
      },
    }))
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
        assert.deepEqual(styles.map(style => style.textContent), expectedStyles, 'restore every stylesheet before inserting the module')
        assert.ok(styles.every(style => style.removedMarker), 'remove stylesheet markers after restoration')
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
      setTimeout, clearTimeout, atob, Uint8Array, TextDecoder, TextEncoder,
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
          const style = selector.match(/^style\[data-figui-style="(\d+)"\]$/)
          if (style) return styles.find(candidate => candidate.index === Number(style[1])) ?? null
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

for (const unicodeDictionary of [false, true]) {
  const options = { unicodeDictionary }
  const source = `
    const unicode = '${'Café — العربية Русский हिन्दी 中文 🛠️ e\u0301'.repeat(20)}';
    const literal = '$& $\u0060 $\u0027';
    const template = \`line one\nline two\`;
    const escapedEnd = '<\\/script>';
    await Promise.resolve();
    export { unicode, literal, template, escapedEnd };
  `
  const prefix = '<!doctype html><html><head><style>body{color:red}</style>'
  const suffix = '</head><body><div id="root"></div><script>/* other script */</script></body></html>'
  const html = `${prefix}<script type="module" crossorigin nonce="test-nonce">${source}</script>${suffix}`
  const packed = await packEsp32Html(html, options)
  assert.ok(packed.startsWith(prefix))
  assert.ok(packed.endsWith(suffix))
  assert.ok(packed.includes('nonce="test-nonce"'))
  const loaded = await unpack(packed)
  assert.equal(loaded.source, source, 'recover the exact original module, including Unicode')
  assert.equal(loaded.removed, true, 'release the packed script without a load event')
  assert.deepEqual(loaded.errors, [])

  // Varied records keep repeated property names separated by distinct values.
  // This exercises the dictionary path through the actual generated browser loader.
  let seed = 1
  const records = Array.from({ length: 3000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return { controllerPosition: seed, reportedFilename: `part-${seed}.nc`, commandPending: seed % 3 === 0 }
  })
  const largeSource = `const records = ${JSON.stringify(records)};\n${source}`
  const dictionaryPacked = await packEsp32Html(`${prefix}<script type="module">${largeSource}</script>${suffix}`, options)
  assert.ok(dictionaryPacked.includes('TextDecoder'), 'large fixture uses dictionary decoding')
  assert.equal(dictionaryPacked.includes('TextEncoder'), unicodeDictionary, 'only the Unicode variant adds UTF-8 dictionary expansion')
  const dictionaryLoaded = await unpack(dictionaryPacked)
  assert.equal(dictionaryLoaded.source, largeSource, 'browser loader restores the original module byte for byte')
  assert.deepEqual(dictionaryLoaded.errors, [])
  const invalidDictionary = await new Promise((resolve, reject) => {
    lzma.compress([255, ...Buffer.from('1 word'), 0, 129], 3, (data, error) => error ? reject(error) : resolve(Buffer.from(data)))
  })
  const damagedDictionary = dictionaryPacked.replace(/atob\("[A-Za-z0-9+/=]+"\)/, `atob("${invalidDictionary.toString('base64')}")`)
  const dictionaryFailed = await unpack(damagedDictionary)
  assert.equal(dictionaryFailed.source, null, 'do not execute a damaged dictionary payload')
  assert.equal(dictionaryFailed.errors.length, 1)
  assert.match(dictionaryFailed.root.textContent, /Please reload/)

  const css = ':root{--bg:#123}body{background:var(--bg);margin:0}.label:after{content:"Café العربية Русский हिन्दी 中文 🛠️ $&"}@media print{.label{color:red}}'
  const secondCss = '.label{color:green}'
  const styleTag = `<style rel="stylesheet">${secondCss}</style>`
  // An identical-looking tag inside JavaScript must not be mistaken for HTML.
  const styledSource = `const sample = ${JSON.stringify(styleTag)};\n${largeSource}`
  const styledHtml = `${prefix}<script type="module">${styledSource}</script><style rel="stylesheet" nonce="style-nonce" media="screen">${css}</style>${styleTag}${suffix}`
  const styledPacked = await packEsp32Html(styledHtml, { ...options, packStyles: true })
  assert.ok(styledPacked.startsWith(prefix), 'ordinary inline styles remain native')
  assert.ok(styledPacked.includes('nonce="style-nonce" media="screen"'), 'keep stylesheet attributes')
  assert.ok(styledPacked.includes(':root{--bg:#123}body{background:var(--bg);margin:0}'), 'first-paint page styling remains native')
  const styledLoaded = await unpack(styledPacked, [css, secondCss])
  assert.equal(styledLoaded.source, styledSource, 'recover JS separately from CSS, including Unicode and literal style tags')
  assert.deepEqual(styledLoaded.errors, [])
  const missingStyle = await unpack(styledPacked.replace('data-figui-style="0"', 'data-missing-style="0"'))
  assert.equal(missingStyle.source, null, 'do not execute the app without its styles')
  assert.equal(missingStyle.errors.length, 1)
  assert.match(missingStyle.root.textContent, /Please reload/)

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
    await assert.rejects(packEsp32Html(invalid, options))
  }
}

// The smallest raw HTML need not be the smallest download. Check the actual
// gzip selection and that the saved HTML and gzip describe the same candidate.
const varied = Array.from({ length: 500 }, (_, i) => Math.imul(i, 2654435761).toString(36)).join('')
const candidates = [
  { name: 'varied', html: varied },
  { name: 'repeated', html: 'العربية Русский'.repeat(500) },
]
assert.ok(Buffer.byteLength(candidates[1].html) > Buffer.byteLength(candidates[0].html))
for (const ordered of [candidates, [...candidates].reverse()]) {
  const selected = await gzipSmallestHtml(ordered)
  assert.equal(selected.name, 'repeated', 'select by gzip size regardless of candidate order')
  assert.equal(selected.gz.length, Math.min(...selected.sizes.map(item => item.bytes)))
  assert.equal(gunzipSync(selected.gz).toString(), selected.html)
}
const tied = await gzipSmallestHtml([{ name: 'first', html: 'same' }, { name: 'second', html: 'same' }])
assert.equal(tied.name, 'first', 'retain the first candidate on ties')
const single = await gzipSmallestHtml([{ name: 'unpacked', html: 'no packing' }])
assert.equal(single.name, 'unpacked')
assert.equal(gunzipSync(single.gz).toString(), 'no packing')
await assert.rejects(gzipSmallestHtml([]), /At least one/)
console.log('ESP32 packer tests passed: exact JS/CSS recovery, dictionary loader, first-paint styles, cleanup and errors')
