import assert from 'node:assert/strict'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

Object.assign(globalThis, {
  document: Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } } }),
  window: Object.assign(new EventTarget(), { location: { protocol: 'http:', pathname: '/' } }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })

const { useTerminalStore } = await import('../src/store/terminal')
const store = () => useTerminalStore.getState()
const texts = () => store().lines.map(line => line.text)

// A banner on an empty log is just the first line.
store().appendLine('Grbl 3.7 [FluidNC v3.7.8 (wifi) \'$\' for help]')
assert.deepEqual(texts(), ['Grbl 3.7 [FluidNC v3.7.8 (wifi) \'$\' for help]'])

// A reset keeps the lines that explain it and marks where it happened.
store().clear()
store().appendLine('[MSG:ERR: Something went wrong]')
store().appendLine('ALARM:3')
store().appendLine('Grbl 3.7 [FluidNC v3.7.8 (wifi) \'$\' for help]')
const lines = texts()
assert.equal(lines.length, 4)
assert.equal(lines[0], '[MSG:ERR: Something went wrong]')
assert.equal(lines[1], 'ALARM:3')
assert.match(lines[2], /^--- Controller reset .+ ---$/)
assert.equal(lines[3], 'Grbl 3.7 [FluidNC v3.7.8 (wifi) \'$\' for help]')
assert.equal(store().lines[0].kind, 'error')
assert.equal(store().lines[2].kind, 'normal')

// The log stays capped at 1000 lines, newest kept, ids unique.
store().clear()
for (let i = 0; i < 1005; i++) store().appendLine(`line ${i}`)
store().appendLine('Grbl 3.7 [FluidNC]')
assert.equal(store().lines.length, 1000)
assert.equal(texts()[999], 'Grbl 3.7 [FluidNC]')
assert.match(texts()[998], /^--- Controller reset/)
assert.equal(texts()[997], 'line 1004')
assert.equal(new Set(store().lines.map(line => line.id)).size, 1000)

// Filtering is unchanged: ok and status lines stay hidden unless verbose.
store().clear()
store().appendLine('ok')
store().appendLine('<Idle|MPos:0,0,0|FS:0,0>')
assert.deepEqual(texts(), [])

console.log('terminal tests passed')
