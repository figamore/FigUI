import assert from 'node:assert/strict'
import { parseGcStateLine, parseStatusReport } from '../src/lib/parser'
import type { MachineStatus } from '../src/types'

// Mirrors the core merge of useMachineStore.updateStatus: partial parsers are
// spread over the previous status, so every key a parser emits overwrites it.
function merge(prev: Partial<MachineStatus>, update: Partial<MachineStatus> | null) {
  if (!update) return prev
  return { ...prev, ...update }
}

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

check('$G M5 clears spindle to 0 even with a stale S word', () => {
  const parsed = parseGcStateLine('[GC:G0 G54 G17 G21 G90 M5 F200 S1200]')
  assert.equal(parsed?.spindleRunning, false)
  assert.equal(parsed?.spindle, 0)
})

check('exact repro: M3 S12000 then M5 settles at 0 (no flap)', () => {
  let status: Partial<MachineStatus> = { spindle: 0, feed: 0 }
  status = merge(status, parseStatusReport('<Idle|MPos:0.000,0.000,0.000|FS:0,0>'))
  status = merge(status, parseGcStateLine('[GC:G0 G54 G17 G21 G90 M3 S12000]'))
  status = merge(status, parseStatusReport('<Idle|MPos:0.000,0.000,0.000|FS:0,12000>'))
  assert.equal(status.spindle, 12000)
  status = merge(status, parseGcStateLine('[GC:G0 G54 G17 G21 G90 M5 S12000]'))
  status = merge(status, parseStatusReport('<Idle|MPos:0.000,0.000,0.000|FS:0,0>'))
  status = merge(status, parseGcStateLine('[GC:G0 G54 G17 G21 G90 M5 S12000]'))
  assert.equal(status.spindle, 0)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll status parser checks passed')
