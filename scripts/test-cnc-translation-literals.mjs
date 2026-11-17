import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = name => JSON.parse(readFileSync(new URL(`../locales/${name}.json`, import.meta.url), 'utf8'))
const english = read('en')
const englishPlurals = read('plurals.en')

// These are machine/file identifiers, not prose. ASCII boundaries also work
// when a command touches Japanese, Chinese, Korean or Arabic text.
const literals = /(?<![A-Za-z0-9_])(?:[GM]\d+(?:\.\d+)?|[GNT]\{\w+\}|\$[A-Za-z0-9]+(?:=\d+)?|\[ESP\d+\]|CHOPCONF|COOLCONF|THIGH|TCOOLTHRS|GCONF|PWMCONF|IHOLD_IRUN|DIAG0|TOFF|plugin\.json|config\.yaml|job\.nc|8N1)(?![A-Za-z0-9_])/g
const matches = (text, pattern) => [...text.matchAll(pattern)].map(match => match[0]).sort()

// The source uses the mathematical minus for directions. Accept a translated
// ASCII minus too, but not word hyphens such as "Z-height" or "XYZ-Position".
const sourceDirections = /(?<![A-Za-z0-9_])(?:[XYZ][+−]|[+−][XYZ]|[XY]0|\{\w+\}[+−])/g
const translatedDirections = /(?<![A-Za-z0-9_])(?:[XYZ](?:[+−]|-(?![A-Za-z]))|[+−][XYZ]|-(?=[XYZ](?![A-Za-z]))[XYZ]|[XY]0|\{\w+\}(?:[+−]|-(?![A-Za-z])))/g
const directions = text => matches(text.replace(/([XYZ]|\{\w+\})\s+([+−])/g, '$1$2'), translatedDirections).map(token => token.replace('-', '−')).sort()

function check(source, translation, context) {
  assert.deepEqual(matches(translation, literals), matches(source, literals), `${context}: altered CNC command, register or filename`)
  const expectedDirections = matches(source, sourceDirections)
  if (expectedDirections.length) {
    assert.deepEqual(directions(translation), expectedDirections, `${context}: altered probing direction or zero coordinate`)
  }
  if (source.includes('"name" field')) assert.match(translation, /(?<![A-Za-z])name(?![A-Za-z])/, `${context}: translated JSON field name`)
  if (source.includes('exactly true or false')) {
    assert.match(translation, /\btrue\b/, `${context}: translated true literal`)
    assert.match(translation, /\bfalse\b/, `${context}: translated false literal`)
  }
}

// Exercise the checks as well as the real catalogs, including non-Latin
// adjacency, reversed motion and the hyphens that must remain ordinary prose.
assert.throws(() => check('THIGH register', 'Thigh register', 'register'))
assert.throws(() => check('Laser ($32=1)', 'Laser (32$=1)', 'command'))
assert.throws(() => check('Probe Y−', 'Probe Y+', 'direction'))
assert.throws(() => check('Probe {axis}−', 'Probe {axis}+', 'dynamic direction'))
assert.throws(() => check('Set X0 Y0', 'Set X0', 'zero'))
assert.doesNotThrow(() => check('Probe Y− above Z height', 'Y- antasten über Z-Höhe', 'hyphen'))
assert.doesNotThrow(() => check('Use G17', 'G17を使用', 'adjacency'))

for (const { code } of read('languages')) {
  const catalog = read(code)
  for (const [key, source] of Object.entries(english)) check(source, catalog[key], `${code}:${key}`)
  const plurals = read(`plurals.${code}`)
  for (const [key, forms] of Object.entries(plurals)) {
    for (const [category, translation] of Object.entries(forms)) {
      check(englishPlurals[key].other, translation, `${code}:${key}:${category}`)
    }
  }
}
console.log('CNC command, register, filename and probing-direction literals preserved in every locale')
