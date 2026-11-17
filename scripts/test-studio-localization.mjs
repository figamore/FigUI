import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { translateJsx } from './translate-jsx.mjs'

async function studio(locale) {
  const translator = translateJsx(locale)
  const result = await build({
    entryPoints: ['src/components/ConfigStudio.tsx'], bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent',
    define: { __FIGUI_LOCALE__: JSON.stringify(locale) },
    plugins: [{ name: 'localized-source', setup(b) {
      b.onLoad({ filter: /\/src\/.*\.tsx?$/ }, async ({ path }) => {
        const code = await readFile(path, 'utf8')
        return { contents: translator.transform(code, path)?.code ?? code, loader: path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const english = await studio('en'), spanish = await studio('es')
const nodes = [
  { id: 'inputs', kind: 'io', title: 'User inputs', fields: { button: 'gpio.1' } },
  { id: 'outputs', kind: 'io', title: 'User outputs', fields: { relay: 'gpio.2' } },
  { id: 'axis', kind: 'axis', title: 'X Axis', yamlKey: 'x', fields: { axis: 'x' } },
]
for (const node of nodes) {
  assert.equal(spanish.yamlPathForNode(node, nodes), english.yamlPathForNode(node, nodes))
  for (const key of Object.keys(node.fields)) assert.equal(spanish.yamlPathForField(node, key, nodes), english.yamlPathForField(node, key, nodes))
}
assert.equal(spanish.yamlPathForNode(nodes[0], nodes), 'user_inputs')
assert.equal(spanish.yamlPathForNode(nodes[1], nodes), 'user_outputs')
console.log('Studio localization preserves configuration paths')
