import assert from 'node:assert/strict'
import { parseGCode } from '../src/lib/gcode'
import { completedPlungeCount, findPlungePoints } from '../src/lib/gcodeBuild'

const options = { activeWcs: null, currentWco: { x: 0, y: 0, z: 0 }, workOffsets: {} }
const plunges = (lines: string[]) => findPlungePoints(parseGCode(lines.join('\n'), options).segments)

{
  // A drilling file: rapid over the hole, feed down, feed up, rapid up.
  const holes = plunges([
    'G21 G90', 'G0 Z2',
    'G0 X10 Y-5', 'G1 Z-3 F100', 'G1 Z0', 'G0 Z2',
    'G0 X20 Y-5', 'G1 Z-3', 'G1 Z0', 'G0 Z2',
  ])
  assert.equal(holes.count, 2)
  assert.deepEqual(Array.from(holes.xy), [10, -5, 20, -5])
}

{
  // Pecks at one spot are one hole, marked done after the last peck.
  const lines = ['G21 G90', 'G0 Z2', 'G0 X5 Y5', 'G1 Z-1 F100', 'G0 Z1', 'G1 Z-2', 'G0 Z1', 'G1 Z-3', 'G0 Z2', 'G0 X8 Y5', 'G1 Z-3', 'G0 Z2']
  const holes = plunges(lines)
  assert.equal(holes.count, 2)
  const segments = parseGCode(lines.join('\n'), options).segments
  const lastPeck = holes.segments[0]
  assert.equal(segments.pz[lastPeck + 1], -3, 'the first hole is finished by its deepest peck')
  assert.equal(completedPlungeCount(holes, lastPeck), 0, 'not done while the last peck runs')
  assert.equal(completedPlungeCount(holes, lastPeck + 1), 1)
  assert.equal(completedPlungeCount(holes, segments.length), 2)
}

{
  // A second tool drilling the same spots later gives its own markers.
  const holes = plunges(['G21 G90', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-1 F100', 'G0 Z2', 'G0 X2 Y1', 'G1 Z-1', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-3', 'G0 Z2'])
  assert.equal(holes.count, 3)
}

{
  // A tool change between plunges at one spot keeps the holes apart.
  const holes = plunges(['G21 G90', 'T1 M6', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-1 F100', 'G0 Z25', 'T2 M6', 'G0 Z2', 'G1 Z-3', 'G0 Z2'])
  assert.equal(holes.count, 2)
  assert.deepEqual(Array.from(holes.tools), [1, 2])
}

{
  // Leaving a hole and coming back without drilling elsewhere starts a new one,
  // so the first is marked done after its own plunge.
  const holes = plunges(['G21 G90', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-1 F100', 'G0 Z2', 'G0 X5 Y1', 'G0 X1 Y1', 'G1 Z-3', 'G0 Z2'])
  assert.equal(holes.count, 2)
  assert.equal(completedPlungeCount(holes, holes.segments[0] + 1), 1)
}

{
  // Laser work never plunges; upward feeds and ramps are not holes.
  assert.equal(plunges(['G21 G90', 'G0 X0 Y0', 'M4 S500', 'G1 X10 F1000', 'G1 Y10', 'M5']).count, 0)
  assert.equal(plunges(['G21 G90', 'G0 Z-3', 'G1 Z2 F100']).count, 0)
  assert.equal(plunges(['G21 G90', 'G0 Z2', 'G1 X5 Z-1 F100']).count, 0)
  assert.equal(plunges(['G21 G90', 'G0 Z2', 'G0 Z-1']).count, 0, 'a rapid down is not a cut')
}

console.log('Drill marker tests passed')
