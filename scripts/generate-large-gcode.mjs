#!/usr/bin/env node
// Generates a LightBurn-style laser raster engraving file for stress-testing
// the G-code viewer with very large jobs.
//
// Usage: node scripts/generate-large-gcode.mjs <out.nc> [widthMm=200] [heightMm=200] [lineIntervalMm=0.1] [runMm=0.2]

import { createWriteStream } from 'node:fs'

const [out = 'large-raster.nc', widthArg = '200', heightArg = '200', intervalArg = '0.1', runArg = '0.2'] = process.argv.slice(2)
const width = Number(widthArg)
const height = Number(heightArg)
const interval = Number(intervalArg)
const run = Number(runArg)

// Check before opening (and truncating) the output file: a zero interval or
// run would never finish and fill the disk.
for (const [name, value, raw] of [
  ['widthMm', width, widthArg],
  ['heightMm', height, heightArg],
  ['lineIntervalMm', interval, intervalArg],
  ['runMm', run, runArg],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive number, got "${raw}".`)
    process.exit(1)
  }
}

const stream = createWriteStream(out)
let buffered = []
let lines = 0

function emit(line) {
  buffered.push(line)
  lines++
  if (buffered.length >= 10000) flush()
}

function flush() {
  if (buffered.length === 0) return true
  const ok = stream.write(buffered.join('\n') + '\n')
  buffered = []
  return ok
}

emit('; LightBurn-style raster stress test')
emit('G00 G17 G40 G21 G54')
emit('G90')
emit('M4')
emit('; Image @ 6000 mm/min, 80% power')
emit('G0 X10Y10')
emit('G91')

const rows = Math.round(height / interval)
const steps = Math.max(1, Math.round(width / run))
let seed = 12345
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

for (let row = 0; row < rows; row++) {
  const dir = row % 2 === 0 ? 1 : -1
  emit(`G1 X${(dir * 0.5).toFixed(1)}S0F6000`)
  for (let step = 0; step < steps; step++) {
    const power = Math.round(rand() * 800)
    emit(`G1 X${(dir * run).toFixed(2)}S${power}`)
  }
  emit(`G1 X${(dir * 0.5).toFixed(1)}S0`)
  emit(`G0 Y${interval}`)
  if (row % 50 === 0 && !flush()) {
    await new Promise(resolve => stream.once('drain', resolve))
  }
}

emit('G90')
emit('M5')
emit('M2')
flush()
stream.end(() => {
  console.log(`Wrote ${out}: ${lines.toLocaleString()} lines`)
})
