import assert from 'node:assert/strict'
import lzma from 'lzma'
import { unpackLzma } from './unpack-lzma.mjs'

const compress = bytes => Uint8Array.from(lzma.compress(bytes, 3))

// The second copy requires references well past one decode slice. The whole
// output also crosses the encoder's 512 KiB dictionary boundary.
let seed = 1
const block = Uint8Array.from({ length: 300_000 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed >>> 24
})
const farMatches = Buffer.concat([block, block, Buffer.from('AB'.repeat(4096))])
for (const bytes of [
  new Uint8Array(),
  Uint8Array.of(0),
  new Uint8Array(2048).fill(255),
  Uint8Array.from({ length: 256 }, (_, i) => i),
  Uint8Array.from(farMatches),
]) {
  assert.deepEqual(await unpackLzma(compress(bytes), bytes.length), bytes)
}

const bytes = Uint8Array.of(200, 65, 66, 0, 65, 66, 0)
const packed = compress(bytes)
await assert.rejects(unpackLzma(packed, bytes.length + 1), /Invalid LZMA payload/)
for (const invalid of [
  packed.slice(0, 17),
  packed.slice(0, -1),
  Uint8Array.of(...packed, 0),
  Uint8Array.of(92, ...packed.slice(1)),
]) {
  await assert.rejects(unpackLzma(invalid, bytes.length), /Invalid LZMA payload/)
}

console.log('Compact LZMA decoder restores binary data and long matches, and rejects damaged streams')
