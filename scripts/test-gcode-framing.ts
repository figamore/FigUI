import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { parseGCode } from '../src/lib/gcode'
import { buildFramingGCode, programMovesZ } from '../src/lib/gcodeOutline'
import { parseDecimalInput } from '../src/lib/numberInput'

const options = { mode: 'rectangle' as const, feedMmPerMin: 1000, clearanceMm: 5, travelZMm: 5 }

{
  // A hand-focused laser job never commands Z, so framing must not move Z either.
  const laser = ['(Z: focused by hand, Z is never commanded)', 'G21 G90', 'G0 X1 Y1', 'M4 S500', 'G1 X3 Y1 F1000', 'G1 X3 Y2', 'G1 X1 Y2', 'M5'].join('\n')
  assert.equal(programMovesZ(laser), false)
  const frame = buildFramingGCode(parseGCode(laser), { ...options, clearanceMm: NaN, travelZMm: NaN, movesZ: false })
  assert.ok(frame, 'laser frame')
  assert.ok(!/^[^(]*Z/m.test(frame), frame)
  assert.ok(!/M[345]\b/.test(frame), frame)
  assert.ok(frame.includes('G0 X1 Y1\nG1 F1000\nG1 X3 Y1\n'), frame)
  assert.ok(frame.endsWith('G1 X1 Y1\nM2'), frame)
}

{
  // Programs that move Z keep the travel height and the controlled Z approach.
  const milled = ['G21 G90', 'G0 Z5', 'G0 X1 Y1', 'M3 S10000', 'G1 Z-1 F100', 'G1 X3 Y1 F500', 'G1 X3 Y2', 'G0 Z5'].join('\n')
  assert.equal(programMovesZ(milled), true)
  assert.equal(programMovesZ('G0 X1 (Z5)\nG1 Y2 ; Z-1\n'), false)
  assert.equal(programMovesZ('g1 x1 z-0.2\n'), true)
  // Parameter and expression Z words count too, so framing errs toward lifting Z.
  assert.equal(programMovesZ('G0 Z#1\n'), true)
  assert.equal(programMovesZ('G1 Z[#<depth>]\n'), true)
  const frame = buildFramingGCode(parseGCode(milled), { ...options, movesZ: true })
  assert.ok(frame && ['G0 Z5', 'G1 F200', 'G1 Z4'].every(line => frame.includes(`${line}\n`)), frame ?? '')
  assert.throws(() => buildFramingGCode(parseGCode(milled), { ...options, travelZMm: 2, movesZ: true }), /Safe travel height/)
}

{
  // Comma decimals typed on a Turkish keyboard keep their fraction.
  assert.equal(parseDecimalInput('0,5'), 0.5)
  assert.equal(parseDecimalInput('2,5'), 2.5)
  assert.equal(parseDecimalInput('abc'), null)
}

// Optionally a real Z-less laser file: FIGUI_FRAMING_SAMPLE=<path to .nc>.
const userFile = process.env.FIGUI_FRAMING_SAMPLE
if (userFile) {
  assert.ok(existsSync(userFile), `FIGUI_FRAMING_SAMPLE names a missing file: ${userFile}`)
  const text = readFileSync(userFile, 'utf8')
  const started = performance.now()
  assert.equal(programMovesZ(text), false)
  const ms = performance.now() - started
  const frame = buildFramingGCode(parseGCode(text), { ...options, movesZ: false })
  assert.ok(frame && !/^[^(]*Z/m.test(frame), frame ?? '')
  console.log(`${userFile}: Z scan ${ms.toFixed(1)} ms, frame has ${frame.split('\n').length} lines`)
}

console.log('G-code framing tests passed')
