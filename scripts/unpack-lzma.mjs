/*
Based on LZMA-JS (MIT).

© 2016 Nathan Rugg <nmrugg@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

// LZMA1 decoder for the stream emitted by LZMA-JS mode 3 (lc=3, lp=0, pb=2).
// The entire output is already needed for the inline module, so previous bytes
// can serve as the dictionary instead of being copied through a ring buffer.
export async function unpackLzma(input, size) {
  const fail = () => { throw new Error('Invalid LZMA payload') }
  if (input.length < 18) fail()
  const header = new DataView(input.buffer, input.byteOffset, 13)
  const dictionarySize = header.getUint32(1, true)
  if (input[0] !== 93 || dictionarySize !== 524288 ||
      header.getUint32(5, true) !== size || header.getUint32(9, true) !== 0 ||
      input[13] !== 0) fail()

  const output = new Uint8Array(size)
  let cursor = 14
  let offset = 0
  let range = 0xffffffff
  let code = 0
  function readByte() {
    if (cursor === input.length) fail()
    return input[cursor++]
  }
  for (let i = 0; i < 4; i++) code = (code << 8 | readByte()) >>> 0

  function normalizeRange() {
    if (range < 0x1000000) {
      range = (range << 8) >>> 0
      code = (code << 8 | readByte()) >>> 0
    }
  }

  function bit(probabilities, index) {
    const probability = probabilities[index]
    const bound = (range >>> 11) * probability
    let decoded = 0
    if (code < bound) {
      range = bound
      probabilities[index] += (2048 - probability) >>> 5
    } else {
      code -= bound
      range -= bound
      probabilities[index] -= probability >>> 5
      decoded = 1
    }
    normalizeRange()
    return decoded
  }

  function tree(probabilities, base, bits) {
    let node = 1
    for (let i = 0; i < bits; i++) node = node * 2 + bit(probabilities, base + node)
    return node - (1 << bits)
  }

  function reverseTree(probabilities, base, bits) {
    let node = 1
    let value = 0
    for (let i = 0; i < bits; i++) {
      const digit = bit(probabilities, base + node)
      node = node * 2 + digit
      value |= digit << i
    }
    return value
  }

  const model = length => new Uint16Array(length).fill(1024)
  const matches = model(48)
  const repeated = model(12)
  const repeatFirst = model(12)
  const repeatSecond = model(12)
  const repeatThird = model(12)
  const shortRepeat = model(48)
  const literals = model(8 * 768)
  const distanceSlots = model(4 * 64)
  const distances = model(114)
  const align = model(16)
  const matchLengths = model(2 + 8 * 8 + 256)
  const repeatLengths = model(matchLengths.length)
  function readLength(probabilities, position) {
    if (!bit(probabilities, 0)) return 2 + tree(probabilities, 2 + position * 8, 3)
    if (!bit(probabilities, 1)) return 10 + tree(probabilities, 34 + position * 8, 3)
    return 18 + tree(probabilities, 66, 8)
  }

  function readDistance(length) {
    const slot = tree(distanceSlots, Math.min(length - 2, 3) * 64, 6)
    if (slot < 4) return slot
    const bits = (slot >>> 1) - 1
    let distance = (2 | (slot & 1)) * 2 ** bits
    if (slot < 14) return distance + reverseTree(distances, distance - slot - 1, bits)
    for (let i = bits - 1; i >= 4; i--) {
      range >>>= 1
      if (code >= range) {
        code -= range
        distance += 2 ** i
      }
      normalizeRange()
    }
    return distance + reverseTree(align, 0, 4)
  }

  let state = 0
  let distance = 0
  let previous1 = 0
  let previous2 = 0
  let previous3 = 0
  let nextCheck = 65536
  let sliceStarted = Date.now()
  for (;;) {
    if (offset >= nextCheck) {
      nextCheck = offset + 65536
      if (Date.now() - sliceStarted >= 32) {
        await new Promise(resolve => setTimeout(resolve, 0))
        sliceStarted = Date.now()
      }
    }
    const position = offset & 3
    const context = state * 4 + position
    if (!bit(matches, context)) {
      if (offset === size) fail()
      const base = ((output[offset - 1] ?? 0) >>> 5) * 768
      let node = 1
      if (state >= 7) {
        let match = output[offset - distance - 1]
        while (node < 256) {
          const matchBit = (match >>> 7) & 1
          match <<= 1
          const digit = bit(literals, base + (matchBit + 1) * 256 + node)
          node = node * 2 + digit
          if (digit !== matchBit) break
        }
      }
      while (node < 256) node = node * 2 + bit(literals, base + node)
      output[offset++] = node
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
      continue
    }

    let length
    if (bit(repeated, state)) {
      if (!bit(repeatFirst, state)) {
        if (!bit(shortRepeat, context)) length = 1
      } else {
        let reused = previous1
        if (bit(repeatSecond, state)) {
          reused = previous2
          if (bit(repeatThird, state)) {
            reused = previous3
            previous3 = previous2
          }
          previous2 = previous1
        }
        previous1 = distance
        distance = reused
      }
      length ??= readLength(repeatLengths, position)
      state = state < 7 ? (length === 1 ? 9 : 8) : 11
    } else {
      previous3 = previous2
      previous2 = previous1
      previous1 = distance
      length = readLength(matchLengths, position)
      distance = readDistance(length)
      if (distance === 0xffffffff) {
        if (offset !== size || cursor !== input.length || code !== 0) fail()
        return output
      }
      state = state < 7 ? 7 : 10
    }
    if (distance >= offset || distance >= dictionarySize || length > size - offset) fail()
    for (let i = 0; i < length; i++, offset++) output[offset] = output[offset - distance - 1]
  }
}
