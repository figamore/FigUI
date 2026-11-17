import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enabledLanguages } from './languages.mjs'

/** Build sequentially: each Vite build replaces dist/index.html.gz. */
export function buildReleaseLanguages({
  outDir,
  languages = enabledLanguages(),
  source = 'dist/index.html.gz',
  build = code => execFileSync('npm', ['run', 'build:esp32'], {
    stdio: 'inherit', env: { ...process.env, VITE_FIGUI_LOCALE: code },
  }),
}) {
  if (!outDir) throw new Error('A release artifact directory is required')
  mkdirSync(outDir, { recursive: true })
  for (const { code } of languages) {
    console.log(`Building UI: ${code}`)
    build(code)
    const name = code === 'en' ? 'index.html.gz' : `index.${code}.html.gz`
    copyFileSync(source, join(outDir, name))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildReleaseLanguages({ outDir: process.env.FIGUI_RELEASE_DIR })
}
