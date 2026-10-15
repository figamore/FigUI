import assert from 'node:assert/strict'
import { MOVE_FEED, parseGCode } from '../src/lib/gcode'
import { buildRenderLines } from '../src/lib/gcodeBuild'
import { buildJobTimingEstimate } from '../src/lib/jobRuntime'
import { buildFramingGCode } from '../src/lib/gcodeOutline'
import type { ControllerSettings } from '../src/types'

const near = (actual: number, expected: number, message: string, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`)

function renderedRange(text: string) {
  const lines = buildRenderLines(parseGCode(text).segments)
  const range = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (let index = 0; index < lines.count * 2; index++) {
    if (lines.kinds[index >> 1] !== MOVE_FEED) continue
    const [x, y, z] = lines.positions.subarray(index * 3, index * 3 + 3)
    range.minX = Math.min(range.minX, x); range.maxX = Math.max(range.maxX, x)
    range.minY = Math.min(range.minY, y); range.maxY = Math.max(range.maxY, y)
    range.minZ = Math.min(range.minZ, z); range.maxZ = Math.max(range.maxZ, z)
  }
  return range
}

{
  // G18 half circle from X0 to X10: drawn in XZ, dipping to Z-5 as FluidNC
  // cuts it (G2 is clockwise in FluidNC's Z-X axis order).
  const range = renderedRange('G21 G90\nG0 X0 Y0 Z0\nG18 G2 X10 Z0 I5 K0 F100')
  near(range.minY, 0, 'G18 min Y'); near(range.maxY, 0, 'G18 max Y')
  near(range.minZ, -5, 'G18 min Z'); near(range.maxZ, 0, 'G18 max Z')
  near(range.minX, 0, 'G18 min X'); near(range.maxX, 10, 'G18 max X')
}

{
  // G19 quarter circle in YZ; X stays put.
  const range = renderedRange('G21 G90\nG0 X3 Y0 Z0\nG19 G2 Y5 Z5 J5 K0 F100')
  near(range.minX, 3, 'G19 min X'); near(range.maxX, 3, 'G19 max X')
  near(range.maxY, 5, 'G19 max Y'); near(range.maxZ, 5, 'G19 max Z')
}

{
  // G17 arcs are unchanged: a G2 half circle from X0 to X10 bulges toward +Y.
  const range = renderedRange('G21 G90\nG0 X0 Y0 Z0\nG17 G2 X10 Y0 I5 J0 F100')
  near(range.maxY, 5, 'G17 max Y'); near(range.minZ, 0, 'G17 min Z'); near(range.maxZ, 0, 'G17 max Z')
}

{
  // G18 R arc: the centre is on FluidNC's side (K = +4.899 for G2 X10 Z0 R7),
  // so the short arc dips to Z-2.1.
  const text = 'G21 G90\nG0 X0 Y0 Z0\nG18 G2 X10 Z0 R7 F100'
  const arc = parseGCode(text).segments.get(1)
  near(arc.i ?? NaN, 5, 'R arc I'); near(arc.k ?? NaN, Math.sqrt(24), 'R arc K')
  const range = renderedRange(text)
  near(range.minZ, Math.sqrt(24) - 7, 'R arc min Z'); near(range.maxZ, 0, 'R arc max Z')
}

{
  // The runtime estimate times a G18 quarter arc as a quarter, like the same
  // arc in G17, not as the remaining three quarters.
  const settings = { maxRateX: 5000, maxRateY: 5000, maxRateZ: 5000, accelX: 500, accelY: 500, accelZ: 500 } as ControllerSettings
  const seconds = (text: string) => buildJobTimingEstimate(parseGCode(text), settings)?.totalSeconds ?? NaN
  const xz = seconds('G21 G90\nG0 X0 Y0 Z0\nG18 G2 X5 Z-5 I5 K0 F100')
  const xy = seconds('G21 G90\nG0 X0 Y0 Z0\nG17 G3 X5 Y-5 I5 J0 F100')
  near(xz, xy, 'G18 quarter arc seconds', 0.05)
  near(xy, (Math.PI * 5 / 2) / 100 * 60, 'G17 quarter arc seconds', 0.2)
}

{
  // The framing outline follows the XY footprint of a G18 arc (a line on Y0),
  // not a phantom half circle reaching Y5.
  const frame = buildFramingGCode(
    parseGCode('G21 G90\nG0 X0 Y0 Z0\nG18 G2 X10 Z0 I5 K0 F100\nG17 G1 Y2'),
    { mode: 'rectangle', feedMmPerMin: 1000, clearanceMm: 5, travelZMm: 5 },
  )
  assert.ok(frame, 'frame')
  const ys = [...frame.matchAll(/^G[01] X\S+ Y(\S+)/gm)].map(match => Number(match[1]))
  assert.ok(ys.length > 0 && Math.max(...ys) <= 2 + 1e-6 && Math.min(...ys) >= -1e-6, frame)
}

console.log('G-code arc tests passed')
