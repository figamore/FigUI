import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'figui-i18n-audit-'))
const script = fileURLToPath(new URL('./audit-untranslated.mjs', import.meta.url))
try {
  mkdirSync(join(dir, 'src'))
  const file = join(dir, 'src', 'Example.tsx')
  function audit(source) {
    writeFileSync(file, source)
    return spawnSync(process.execPath, [script, '--strict'], { cwd: dir, encoding: 'utf8' })
  }
  for (const source of [
    '<button>Untranslated</button>',
    '<Button label="Untranslated" />',
    '<button title={`Show ${name} now`} />',
    '<div>{error || "Untranslated error"}</div>',
    'confirm("Delete this file?")',
    'setStatusMsg(`Uploading ${name}…`)',
    '<span>{value || `Issue ${count}`}</span>',
    'const item = { message: "Untranslated message" }',
  ]) assert.equal(audit(source).status, 1, source)
  assert.equal(audit('<button>{__uiText("key", "English")}</button>').status, 0)
  console.log('Translation coverage audit checks passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
