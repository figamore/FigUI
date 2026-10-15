import assert from 'node:assert/strict'
import { parseGCode, type ParseGCodeOptions } from '../src/lib/gcode'

const end = (lines: string[], options?: ParseGCodeOptions) => {
  const s = parseGCode(lines.join('\n'), options).segments
  const last = s.get(s.length - 1)
  return [s.length, last.x1, last.y1, last.z1]
}

// G92 on some axes keeps the other axes' offsets; G92.1 clears them.
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G92 X0 Y0', 'G92 X5', 'G0 X5 Y0']), [2, 10, 10, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G92 X0 Y0', 'G92.1', 'G0 X1 Y1']), [2, 1, 1, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G92 X0', 'G92 Y0', 'G0 X5 Y5']), [2, 15, 15, 0])

// G10 L20 / L2 and G43.1 do not move; L20 on the active system moves the zero.
assert.deepEqual(end(['G90', 'G1 X10 Y10 F100', 'G10 L20 P1 X0 Y0', 'G1 X20 Y10']), [2, 30, 20, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G10 L20 P0 X0', 'G0 X1']), [2, 11, 10, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G10 L2 P1 X-100 Y-50', 'G0 X0 Y0']), [2, -100, -50, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G10 L2 P1 X5 Y5', 'G0 X0 Y0'], { activeWcs: 'G54', currentWco: { x: 2, y: 3, z: 0 } }), [2, 3, 2, 0])
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G43.1 Z-2.5', 'G0 X1']), [2, 1, 10, 0])
// L20 on another system takes effect when the program selects it.
assert.deepEqual(end(['G54 G90', 'G0 X10 Y10', 'G10 L20 P2 X0 Y0', 'G0 X1', 'G55 G0 X1 Y1']), [3, 11, 11, 0])
{
  const model = parseGCode(['G90', 'G0 X10 Y10', 'G10 L2 P1 X-100 Y-50'].join('\n'))
  assert.equal(model.bounds.minX, 0)
}

// A probe's end is unknown: zeroing a probed axis keeps later moves at their words.
assert.deepEqual(end(['G21 G90', 'G0 Z10', 'G38.2 Z-20 F100', 'G10 L20 P0 Z0', 'G0 Z5', 'G1 Z-1']), [4, 0, 0, -1])
assert.deepEqual(end(['G90', 'G0 Z10', 'G38.2 Z-20 F100', 'G92 Z0', 'G0 Z5']), [3, 0, 0, 5])
assert.deepEqual(end(['G90', 'G0 X10 Y10 Z5', 'G38.2 X20 F100', 'G10 L20 P0 X-1.5 Z0', 'G0 X0']), [3, 0, 10, 5])
assert.deepEqual(end(['G90', 'G0 Z10', 'G38.2 Z-20 F100', 'G0 Z3', 'G10 L20 P0 Z0', 'G0 Z1']), [4, 0, 0, 4])
assert.deepEqual(end(['G54 G90', 'G38.2 Z-20 F100', 'G10 L20 P2 Z0', 'G55 G0 Z1']), [2, 0, 0, 1])

// G53 moves in machine coordinates for one line, even in G91.
assert.deepEqual(end(['G90', 'G0 X10 Y10', 'G53 G0 X-200 Z-1', 'G0 Y1'], { currentWco: { x: -300, y: -100, z: -10 } }), [3, 100, 1, 9])
assert.deepEqual(end(['G91', 'G0 X10 Y10', 'G53 G0 Z-1', 'G0 X1'], { currentWco: { x: 0, y: 0, z: -10 } }), [3, 11, 10, 9])

// Numbers FluidNC accepts: '+', blanks anywhere in a word.
assert.deepEqual(end(['G1 X+10 Y+5 F100']), [1, 10, 5, 0])
assert.deepEqual(end(['G01 X 10.0 Y 5.0 F 100']), [1, 10, 5, 0])
assert.deepEqual(end(['G1 X2 0 Y- 3 .5']), [1, 20, -3.5, 0])
assert.deepEqual(end(['G 1 X1\tY2\r']), [1, 1, 2, 0])
assert.deepEqual(end(['G1 X1.5 Y.5 Z5.', 'G1 X-.25']), [2, -0.25, 0.5, 5])
assert.deepEqual(end(['G1 X1234567890.1234567 Y1']), [1, 1234567890.1234567, 1, 0])
assert.deepEqual(end(['G1 X12345 67890.1234567 Y1']), [1, 1234567890.1234567, 1, 0])
assert.equal(parseGCode('G1 X. Y.').segments.length, 0)

// An unterminated '(' comment runs to the end of the line.
assert.deepEqual(end(['G0 X1', '(Tool T2 note X50 Y50', 'G0 Y1']), [2, 1, 1, 0])
assert.deepEqual(end(['G0 Y2 (a (b) X5', 'G0 Y1 (c X9']), [2, 5, 1, 0])

console.log('gcode parser tests passed')
