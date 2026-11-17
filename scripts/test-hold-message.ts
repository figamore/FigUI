import assert from 'node:assert/strict'
Object.assign(globalThis, {
  localStorage: { getItem: () => null },
  document: { documentElement: { classList: { add() {}, remove() {} } } },
})
const { parseHoldMessage } = await import('../src/store/holdMonitor')

assert.equal(parseHoldMessage('[MSG:Files changed]'), null)
assert.equal(parseHoldMessage('[MSG:INFO: Files changed]'), null)
assert.equal(parseHoldMessage('[MSG:WARN: MSG,Check tool]'), null)
assert.equal(parseHoldMessage('[MSG:INFO: MSG,Change tool]'), 'Change tool')
assert.equal(parseHoldMessage('[MSG:PRINT,Check fixture]'), 'Check fixture')
assert.equal(parseHoldMessage('[MSG:INFO: Install tool 2 and resume to continue]'), 'Install tool 2 and resume to continue')
