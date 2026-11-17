// Lossless text preprocessing for LZMA. This changes the stored representation,
// never JavaScript identifiers: the original source is restored before execution.
const WORD = /[A-Za-z_$][\w$]*/g
const WORD_OR_CHARACTER = /[A-Za-z_$][\w$]*|[^\x00-\x7f]/gu
const DIRECT_WORDS = 124
const MAX_WORDS = 1024

export function encodeSource(source, { unicode = false } = {}) {
  const pattern = unicode ? WORD_OR_CHARACTER : WORD
  // Non-ASCII UTF-8 bytes each need an escape byte in the literal stream.
  const cost = word => unicode
    ? 2 * Buffer.byteLength(word) - word.replace(/[^\x00-\x7f]/g, '').length
    : word.length
  const counts = new Map()
  for (const [word] of source.matchAll(pattern)) {
    if (cost(word) > 2) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const words = [...counts]
    .filter(([, count]) => count > 1)
    .sort((a, b) => (cost(b[0]) - 2) * b[1] - (cost(a[0]) - 2) * a[1])
    .slice(0, MAX_WORDS)
    // Give the most frequent selected words the one-byte token slots.
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
  const indices = new Map(words.map((word, index) => [word, index]))
  const original = Buffer.from(source)
  // 0xff makes LZMA-JS return bytes, rather than guessing that this is UTF-8.
  // The UTF-8 header is byte length, dictionary entries, then a NUL separator.
  const bytes = [255]
  for (const byte of Buffer.from(`${original.length} ${words.join(' ')}`)) bytes.push(byte)
  bytes.push(0)
  function append(text) {
    for (const byte of Buffer.from(text)) {
      // Raw NUL/non-ASCII bytes are escaped; their UTF-8 sequence stays intact.
      if (byte === 0 || byte >= 128) bytes.push(0)
      bytes.push(byte)
    }
  }
  let end = 0
  for (const match of source.matchAll(pattern)) {
    const index = indices.get(match[0])
    if (index === undefined) continue
    append(source.slice(end, match.index))
    end = match.index + match[0].length
    if (index < DIRECT_WORDS) bytes.push(128 + index)
    else bytes.push(252 + ((index - DIRECT_WORDS) >> 8), (index - DIRECT_WORDS) & 255)
  }
  append(source.slice(end))
  return bytes
}

// Embedded verbatim in the browser loader. Keep this function self-contained.
export function decodeSource(data) {
  if (typeof data === 'string') return data
  const bytes = Uint8Array.from(data)
  const boundary = bytes.indexOf(0, 1)
  if (bytes[0] !== 255 || boundary < 0) throw new Error('Invalid packed source')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const words = decoder.decode(bytes.subarray(1, boundary)).split(' ')
  const size = Number(words.shift())
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid packed source length')
  const output = new Uint8Array(size)
  let offset = 0
  for (let i = boundary + 1; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === 0) {
      if (++i === bytes.length) throw new Error('Truncated packed source')
      output[offset++] = bytes[i]
    } else if (byte < 128) output[offset++] = byte
    else {
      const index = byte < 252 ? byte - 128 : 124 + ((byte - 252) << 8) + bytes[++i]
      const word = words[index]
      if (!word) throw new Error('Invalid packed source word')
      for (let j = 0; j < word.length; j++) output[offset++] = word.charCodeAt(j)
    }
  }
  if (offset !== size) throw new Error('Invalid restored source length')
  return decoder.decode(output)
}

// Separate self-contained decoder so ASCII builds keep their existing loader
// byte for byte. Only the Unicode candidate pays for UTF-8 dictionary expansion.
export function decodeUnicodeSource(data) {
  if (typeof data === 'string') return data
  const bytes = Uint8Array.from(data)
  const boundary = bytes.indexOf(0, 1)
  if (bytes[0] !== 255 || boundary < 0) throw new Error('Invalid packed source')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const words = decoder.decode(bytes.subarray(1, boundary)).split(' ')
  const size = Number(words.shift())
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid packed source length')
  const encoder = new TextEncoder()
  const dictionary = words.map(word => encoder.encode(word))
  const output = new Uint8Array(size)
  let offset = 0
  for (let i = boundary + 1; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === 0) {
      if (++i === bytes.length) throw new Error('Truncated packed source')
      output[offset++] = bytes[i]
    } else if (byte < 128) output[offset++] = byte
    else {
      const index = byte < 252 ? byte - 128 : 124 + ((byte - 252) << 8) + bytes[++i]
      const word = dictionary[index]
      if (!word?.length) throw new Error('Invalid packed source word')
      for (let j = 0; j < word.length; j++) output[offset++] = word[j]
    }
  }
  if (offset !== size) throw new Error('Invalid restored source length')
  return decoder.decode(output)
}
