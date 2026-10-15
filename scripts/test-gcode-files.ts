import assert from 'node:assert/strict'
import { pathHoldsRunningFile } from '../src/lib/gcodeFiles'

// No job, no match.
assert.equal(pathHoldsRunningFile(undefined, 'sd', '/sd/F-Cu-Lazer.nc'), false)
assert.equal(pathHoldsRunningFile('', 'sd', '/sd/F-Cu-Lazer.nc'), false)

// The running file itself, with or without the /sd prefix and in any case.
assert.equal(pathHoldsRunningFile('/sd/F-Cu-Lazer.nc', 'sd', '/sd/F-Cu-Lazer.nc'), true)
assert.equal(pathHoldsRunningFile('/sd/F-Cu-Lazer.nc', 'sd', '/sd/f-cu-lazer.NC'), true)
assert.equal(pathHoldsRunningFile('F-Cu-Lazer.nc', 'sd', '/sd/F-Cu-Lazer.nc'), true)
assert.equal(pathHoldsRunningFile('/sd/jobs/a.nc', 'sd', '/sd/jobs/a.nc'), true)

// Other files stay free.
assert.equal(pathHoldsRunningFile('/sd/F-Cu-Lazer.nc', 'sd', '/sd/B-Cu-Lazer.nc'), false)
assert.equal(pathHoldsRunningFile('/sd/jobs/a.nc', 'sd', '/sd/old/a.nc'), false)
assert.equal(pathHoldsRunningFile('/sd/jobs/a.nc', 'sd', '/sd/jobs/a.nc.bak'), false)

// A folder that holds the running file.
assert.equal(pathHoldsRunningFile('/sd/jobs/a.nc', 'sd', '/sd/jobs'), true)
assert.equal(pathHoldsRunningFile('/sd/jobs/a.nc', 'sd', '/sd/jobs2'), false)

// A bare running name is matched by basename (busy rather than missed).
assert.equal(pathHoldsRunningFile('a.nc', 'sd', '/sd/jobs/a.nc'), true)

// The SD job does not hold a same-named file on the internal flash, and the
// other way round.
assert.equal(pathHoldsRunningFile('/sd/a.nc', 'local', '/a.nc'), false)
assert.equal(pathHoldsRunningFile('/localfs/a.nc', 'local', '/a.nc'), true)
assert.equal(pathHoldsRunningFile('/localfs/a.nc', 'sd', '/sd/a.nc'), false)

// File URLs: FluidNC decodes the request path, so "+" must not reach it raw
// (it was read as a space and the previously selected file stayed loaded).
const memory = new Map<string, string>()
Object.assign(globalThis, {
  document: { documentElement: { classList: { add() {}, remove() {} } } },
  localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
})
const { encodeFilePath } = await import('../src/lib/http')
assert.equal(encodeFilePath('/sd/02-Delik-1.00+pim.nc'), '/sd/02-Delik-1.00%2Bpim.nc')
assert.equal(encodeFilePath('/sd/jobs/a b#1?.nc'), '/sd/jobs/a%20b%231%3F.nc')

console.log('gcode files tests passed')
