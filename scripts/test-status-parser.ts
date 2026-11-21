import assert from 'node:assert/strict'
import { parseGcStateLine, parseStatusReport } from '../src/lib/parser'
import { doorPhaseText, isDoorBlocked } from '../src/lib/door'
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

check('Door substates map to door phases', () => {
  const phase = (raw: string) => parseStatusReport(raw)?.doorPhase
  assert.equal(phase('<Door:0|MPos:0.000,0.000,0.000|FS:0,0>'), 'ready')
  assert.equal(phase('<Door:1|MPos:0.000,0.000,0.000|FS:0,0|Pn:D>'), 'open')
  assert.equal(phase('<Door:2|MPos:0.000,0.000,0.000|FS:250,0>'), 'parking')
  assert.equal(phase('<Door:3|MPos:0.000,0.000,0.000|FS:800,0>'), 'restoring')
  assert.equal(phase('<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>'), undefined)
  assert.equal(isDoorBlocked({ state: 'Door', doorPhase: 'ready' }), false)
  for (const doorPhase of ['open', 'parking', 'restoring', undefined] as const) {
    assert.equal(isDoorBlocked({ state: 'Door', doorPhase }), true)
  }
  assert.equal(isDoorBlocked({ state: 'Hold', doorPhase: undefined }), false)
  const texts = new Set((['ready', 'open', 'parking', 'restoring'] as const).map(doorPhaseText))
  assert.equal(texts.size, 4, 'each door phase has its own text')
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll status parser checks passed')
