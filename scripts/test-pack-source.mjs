import assert from 'node:assert/strict'
import lzma from 'lzma'
import { encodeSource, decodeSource, decodeUnicodeSource } from './pack-source.mjs'

const words = Array.from({ length: 1100 }, (_, i) => `property${String(i).padStart(4, '0')}`)
const unicode = '\ufeffCafé — 中文 🛠️\0' + Array.from({ length: 1920 }, (_, i) => String.fromCharCode(128 + i)).join('')
for (const useUnicode of [false, true]) {
  const decode = useUnicode ? decodeUnicodeSource : decodeSource
  for (const source of [
    '',
    'const value = 123;',
    `${unicode}\n${words.join(' ')}\n${words.join(' ')}\n${unicode}`,
    'a'.repeat(200_000) + '\n' + 'a'.repeat(200_000),
    'العربية Русский हिन्दी 中文 🛠️ e\u0301\ufeff\0'.repeat(100),
    // More than 124 Unicode entries exercises multibyte characters in both token widths.
    Array.from({ length: 1300 }, (_, i) => String.fromCodePoint(0x20000 + i)).join('').repeat(3),
  ]) {
    const encoded = encodeSource(source, { unicode: useUnicode })
    assert.equal(decode(encoded), source, 'restore words, escapes, Unicode and all token widths exactly')
    const packed = await new Promise((resolve, reject) => {
      lzma.compress(encoded, 3, (data, error) => error ? reject(error) : resolve(data))
    })
    assert.equal(decode(lzma.decompress(packed)), source, 'LZMA must preserve the binary representation')
  }
  assert.equal(decode(unicode), unicode, 'plain LZMA strings still work')

  const header = [...Buffer.from('1 repeated'), 0]
  for (const invalid of [
    [],
    [255],
    [254, ...header, 65],
    [255, ...Buffer.from('NaN repeated'), 0, 65],
    [255, ...header, 0],
    [255, ...header, 252],
    [255, ...header, 129],
    [255, ...header, 65, 66],
    [255, ...header, 0, 255],
  ]) assert.throws(() => decode(invalid), 'reject damaged metadata, tokens, lengths and UTF-8')
}

const repeatedUnicode = 'العربية Русский हिन्दी 🛠️'.repeat(100)
assert.ok(encodeSource(repeatedUnicode, { unicode: true }).length < encodeSource(repeatedUnicode).length,
  'frequent Unicode characters replace escaped UTF-8 bytes with dictionary tokens')

console.log('Packed source tests passed: exact binary/LZMA round trips, Unicode, dictionary boundaries and corruption')
