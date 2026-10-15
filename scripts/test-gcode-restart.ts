import assert from 'node:assert/strict'
import { analyzeRestart, buildRestartProgram } from '../src/lib/gcodeRestart'

const options = { sourceName: 'job.nc', sourcePath: '/sd/job.nc', safeMachineZMm: -1, clearanceMm: 2, approachFeedMmPerMin: 100 }

{
  // More remaining lines than a spread call can take as arguments.
  const lines = ['G21 G90', 'G0 X0 Y0', 'M4 S500', 'G1 X1 Y0 F1000']
  for (let i = 0; i < 130_000; i++) lines.push(`G1 X${i % 50} Y${i % 7}`)
  const text = lines.join('\n')
  const analysis = analyzeRestart(text, 5)
  assert.deepEqual(analysis.blockers, [])
  const program = buildRestartProgram(text, analysis, options)
  assert.ok(program.endsWith(`${lines[lines.length - 1]}\n`))

  // Analyses of later lines replay from saved prefix state and must match a fresh scan.
  const late = analyzeRestart(text, 120_003)
  assert.equal(late.resumeLine, 120_003)
  assert.deepEqual(late.state.positionMm, { x: (120_003 - 6) % 50, y: (120_003 - 6) % 7, z: 0 })
  assert.equal(late.state.feedMmPerMin, 1000)
}

{
  // A file without a work offset or tool-length word keeps the controller's
  // active offset and the tool-length offset a manual tool change measured.
  const laser = ['G21 G90 G17 G94', 'G0 X1 Y1', 'M4 S500', 'G1 X2 Y1 F1000', 'G1 X2 Y2', 'M5'].join('\n')
  const analysis = analyzeRestart(laser, 5)
  assert.equal(analysis.state.wcs, null)
  assert.equal(analysis.state.toolLength, null)
  const program = buildRestartProgram(laser, analysis, options)
  assert.ok(!/^[^(]*G5[4-9]/m.test(program), program)
  assert.ok(!/^[^(]*G49/m.test(program), program)
}

{
  // Offsets the program itself commands are restored.
  const milled = ['G21 G90', 'G55', 'G43 H2', 'G0 Z5', 'G0 X1 Y1', 'M3 S10000', 'G1 Z-1 F100', 'G1 X2 Y1 F500', 'G1 X2 Y2'].join('\n')
  const analysis = analyzeRestart(milled, 9)
  assert.deepEqual(analysis.blockers, [])
  assert.equal(analysis.state.wcs, 'G55')
  const program = buildRestartProgram(milled, analysis, options)
  assert.ok(program.includes('\nG55\n') && program.includes('\nG43 H2\n'), program)
  // The offset is set once, before the positioning moves that depend on it.
  assert.equal(program.match(/^G43 H2$/gm)?.length, 1, program)
  assert.ok(program.indexOf('\nG43 H2\n') < program.indexOf('\nG0 X2 Y1\n'), program)

  const cancelled = ['G21 G90', 'G43 H2', 'G49', 'G0 Z5', 'G0 X1 Y1', 'G1 Z-1 F100', 'G1 X2 Y1'].join('\n')
  const cancelledProgram = buildRestartProgram(cancelled, analyzeRestart(cancelled, 7), options)
  assert.equal(cancelledProgram.match(/^[^(]*\bG49\b/gm)?.length, 1, cancelledProgram)
}

{
  // A tool change hands the tool-length offset to the controller: a G49 in the
  // safety header must not cancel the offset a manual tool change measured.
  const header = ['G21 G90 G17 G40 G49 G80', 'G54', 'T1 M6', 'G0 Z5', 'G0 X1 Y1', 'M3 S10000', 'G1 Z-1 F100', 'T2 M6', 'G0 Z5', 'G0 X3 Y3', 'G1 Z-1 F100', 'G1 X4 Y3']
  const afterChange = header.join('\n')
  const analysis = analyzeRestart(afterChange, 12)
  assert.deepEqual(analysis.blockers, [])
  assert.equal(analysis.state.toolLength, null)
  assert.ok(!/^[^(]*G49/m.test(buildRestartProgram(afterChange, analysis, options)))

  // A tool-length word after the change, or on the same line, still counts.
  const nextLine = [...header.slice(0, 8), 'G43 H2', ...header.slice(8)].join('\n')
  assert.ok(buildRestartProgram(nextLine, analyzeRestart(nextLine, 13), options).includes('\nG43 H2\n'))
  const sameLine = [...header.slice(0, 7), 'T2 M6 G43 H2', ...header.slice(8)].join('\n')
  assert.ok(buildRestartProgram(sameLine, analyzeRestart(sameLine, 12), options).includes('\nG43 H2\n'))
}

console.log('G-code restart tests passed')
