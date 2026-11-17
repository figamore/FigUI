import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReleaseLanguages } from './build-release-languages.mjs'

const root = mkdtempSync(join(tmpdir(), 'figui-language-release-'))
try {
  const source = join(root, 'output.gz')
  const outDir = join(root, 'release')
  const languages = ['en', 'es', 'zh-Hans'].map(code => ({ code }))
  buildReleaseLanguages({ outDir, source, languages, build: code => writeFileSync(source, code) })
  assert.equal(readFileSync(join(outDir, 'index.html.gz'), 'utf8'), 'en')
  assert.equal(readFileSync(join(outDir, 'index.es.html.gz'), 'utf8'), 'es')
  assert.equal(readFileSync(join(outDir, 'index.zh-Hans.html.gz'), 'utf8'), 'zh-Hans')
} finally { rmSync(root, { recursive: true, force: true }) }
console.log('Per-language release artifact checks passed')
