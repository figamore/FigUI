import assert from 'node:assert/strict'
import { MOVE_FEED, parseGCode, parseGCodeAsync } from '../src/lib/gcode'
import { buildRenderLines, buildStatic3DGeometry } from '../src/lib/gcodeBuild'
import { buildJobTimingEstimate } from '../src/lib/jobRuntime'
import type { ControllerSettings } from '../src/types'

const near = (actual: number | undefined, expected: number, message: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`)

// Modal state, relative moves, G92 offsets, inches and comments.
{
  const model = parseGCode([
    'G21 G90 (mm) ; absolute',
    'G0 X10 Y5',
    'G91',
    'G1 X2 F600',
    'g1 x-1.5 y.5',
    'G90 G92 X0 Y0',
    'G1 X1',
    'G20 G1 X1 Y1',
    '(G1 X99) ; G1 X99',
  ].join('\n'))
  const s = model.segments
  assert.equal(s.length, 5)
  assert.deepEqual([s.get(0).x0, s.get(0).x1, s.get(0).y1, s.get(0).moveType], [0, 10, 5, 'rapid'])
  near(s.get(1).x1, 12, 'G91 move')
  near(s.get(2).x1, 10.5, 'lower-case relative move')
  near(s.get(2).y1, 5.5, 'leading-dot number')
  near(s.get(3).x1, 11.5, 'G92 offset')
  near(s.get(4).x1, 10.5 + 25.4, 'inch move')
  near(s.get(4).feedMmPerMin, 600, 'modal feed')
  assert.equal(s.sourceLine(4), 8)
  assert.equal(model.totalLines, 9)
}

// Arcs, tools and timing estimate.
{
  const model = parseGCode([
    'T1 M6 (6mm endmill)',
    'M3 S10000',
    'G0 X10 Y0',
    'G2 X0 Y-10 I-10 J0 F500',
    'G3 X10 Y0 R10',
    'T2 M6 (V-bit)',
    'G1 X20',
    'M5',
    'G1 X30',
    'M30',
  ].join('\n'))
  const s = model.segments
  assert.equal(s.length, 5)
  assert.ok(s.isArc(1) && s.get(1).cw === true && s.get(1).i === -10)
  assert.ok(s.isArc(2) && s.get(2).cw === false)
  assert.deepEqual(model.tools?.map(tool => tool.label), ['T1 6mm endmill', 'T2 V-bit'])
  assert.deepEqual([s.tool(1), s.tool(3)], [1, 2])
  assert.equal(s.moveType(4), 'traverse')
  near(model.bounds.minY, -10, 'arc bounds')
  const settings = { maxRateX: 5000, maxRateY: 5000, maxRateZ: 1000, accelX: 200, accelY: 200, accelZ: 100 } as ControllerSettings
  assert.ok((buildJobTimingEstimate(model, settings)?.totalSeconds ?? 0) > 0)
}

// Laser raster rows: thousands of power changes per row become one line each,
// and sliced parsing matches a single pass.
{
  const lines = ['G90', 'M4', 'G0 X0 Y0', 'G91']
  for (let row = 0; row < 40; row++) {
    const dir = row % 2 === 0 ? 1 : -1
    for (let step = 0; step < 500; step++) lines.push(`G1 X${(dir * 0.1).toFixed(1)}S${(step * 7) % 1000}F6000`)
    lines.push('G0 Y0.1')
  }
  const text = lines.join('\n')
  const model = parseGCode(text)
  let slices = 0
  const sliced = await parseGCodeAsync(text, {}, () => { slices++ }, () => true, 0)
  assert.ok(slices > 1)
  assert.equal(sliced.segments.length, model.segments.length)
  assert.deepEqual(Array.from(sliced.segments.px), Array.from(model.segments.px))
  assert.deepEqual(Array.from(sliced.segments.sourceLines), Array.from(model.segments.sourceLines))

  const render = buildRenderLines(model.segments)
  // One cutting line and one row step per row; the zero-length G0 X0 Y0 draws nothing.
  assert.equal(render.count, 40 * 2)
  const geometry = buildStatic3DGeometry(render, false)
  let length = 0
  for (let v = 0; v < geometry.vertices.length; v += 6) {
    length += Math.hypot(geometry.vertices[v + 3] - geometry.vertices[v], geometry.vertices[v + 4] - geometry.vertices[v + 1])
  }
  let cutLength = 0
  for (let i = 0; i < model.segments.length; i++) {
    if (model.segments.moveCode(i) === MOVE_FEED) cutLength += Math.abs(model.segments.px[i + 1] - model.segments.px[i])
  }
  assert.ok(Math.abs(length - cutLength) < 1e-3, `joined lines keep length: ${length} vs ${cutLength}`)
}

console.log('G-code preview tests passed')
