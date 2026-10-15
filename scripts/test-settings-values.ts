import assert from 'node:assert/strict'
import type { FluidNCSetting } from '../src/types'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

Object.assign(globalThis, {
  document: Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } } }),
  window: Object.assign(new EventTarget(), { location: { pathname: '/', protocol: 'http:', host: 'fluidnc.local' } }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
// The bundle is one module, so this stands in for Vite's import.meta.env.
Object.assign(import.meta, { env: { DEV: false } })

const { numericSettingError, isBooleanTreeSetting, activeConfigFile, updateYamlInPlace } =
  await import('../src/components/SettingsPanel')

const setting = (fields: Partial<FluidNCSetting>): FluidNCSetting =>
  ({ P: 'axes/x/steps_per_mm', T: 'R', V: '80', H: '', ...fields })

// Values are checked before they are sent.
const ranged = setting({ T: 'I', M: '0', S: '100' })
assert.equal(numericSettingError(ranged, '50'), null)
assert.equal(numericSettingError(ranged, 'abc'), 'Not a number')
assert.equal(numericSettingError(ranged, '5.5'), 'Must be a whole number')
assert.equal(numericSettingError(ranged, '101'), 'Must be between 0 and 100')
assert.equal(numericSettingError(ranged, '-1'), 'Must be between 0 and 100')
assert.equal(numericSettingError(setting({ M: '1' }), '0.5'), 'Must be at least 1')
assert.equal(numericSettingError(setting({ S: '10' }), '11'), 'Must be at most 10')
assert.equal(numericSettingError(setting({}), '80,5'), null)
// FluidNC reports a uint32 without a range as M=0 S=-1: no maximum, but the minimum holds.
const uint32 = setting({ T: 'I', M: '0', S: '-1' })
assert.equal(numericSettingError(uint32, '4000000000'), null)
assert.equal(numericSettingError(uint32, '-5'), 'Must be at least 0')

// Only true/false items are booleans; enum items are saved by member.
const tree = (O: FluidNCSetting['O']) => setting({ F: 'tree', T: 'B', O })
assert.equal(isBooleanTreeSetting(tree([{ False: 0 }, { True: 1 }])), true)
assert.equal(isBooleanTreeSetting(tree([{ Off: 0 }, { On: 1 }])), false)
assert.equal(isBooleanTreeSetting(tree([{ None: 0 }, { Fixed: 1 }, { Variable: 2 }])), false)
assert.equal(isBooleanTreeSetting(setting({ T: 'B', O: [{ False: 0 }, { True: 1 }] })), false)

// Changes go to the file named by $Config/Filename.
const configName = (V: string) => activeConfigFile([setting({ P: '/Config/Filename', T: 'S', V })])
assert.deepEqual(activeConfigFile([]), { fs: 'local', dir: '/', name: 'config.yaml' })
assert.deepEqual(configName(''), { fs: 'local', dir: '/', name: 'config.yaml' })
assert.deepEqual(configName('laser.yaml'), { fs: 'local', dir: '/', name: 'laser.yaml' })
assert.deepEqual(configName('/localfs/cnc.yaml'), { fs: 'local', dir: '/', name: 'cnc.yaml' })
assert.deepEqual(configName('/sd/machines/cnc.yaml'), { fs: 'sd', dir: '/machines/', name: 'cnc.yaml' })

// A key the file does not contain is reported, not dropped silently.
const yaml = 'name: "A # B"  # quoted hash stays\naxes:\n  x:\n    steps_per_mm: 80  # tuned\nmacros:\n  macro0: G0 #fr\n'
assert.equal(updateYamlInPlace(yaml, '/axes/y/steps_per_mm', '81'), null)
// Inline comments are kept by the validator's rule: not inside quotes, not in a macro.
assert.equal(
  updateYamlInPlace(yaml, '/axes/x/steps_per_mm', '81'),
  yaml.replace('steps_per_mm: 80  # tuned', 'steps_per_mm: 81  # tuned'),
)
assert.equal(
  updateYamlInPlace(yaml, '/name', '"C"'),
  yaml.replace('name: "A # B"  # quoted hash stays', 'name: "C"  # quoted hash stays'),
)
assert.equal(
  updateYamlInPlace(yaml, '/macros/macro0', 'G0 X0'),
  yaml.replace('macro0: G0 #fr', 'macro0: G0 X0'),
)

console.log('Settings value tests passed.')
