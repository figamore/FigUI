import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { gzipAsync } from '@gfx/zopfli'
import { packEsp32Html } from './pack-esp32.mjs'

const KB = 1024
const ESP32_SPIFFS_LIMIT = 178 * KB

function hr() { console.log('-'.repeat(50)) }
function fmt(bytes) { return `${(bytes / KB).toFixed(1)} KB` }

hr()
console.log('FigUI - ESP32 Build Pipeline')
hr()

console.log('\n[1/5] Extracting Tailwind class registry...\n')
execSync('npx --no-install tw-patch install', { stdio: 'inherit' })
execSync('npx --no-install tw-patch extract', { stdio: 'inherit' })

console.log('\n[2/5] Compiling & bundling (vite esp32 mode)...\n')
execSync('npx vite build --mode esp32', { stdio: 'inherit' })

console.log('\n[3/5] Reading output...')
const htmlPath = 'dist/index.html'
let html = readFileSync(htmlPath, 'utf8')
console.log(`  index.html  ${fmt(Buffer.byteLength(html))}`)

const faviconPath = 'public/favicon.png'
if (existsSync(faviconPath)) {
  const faviconB64 = readFileSync(faviconPath).toString('base64')
  const dataUri = `data:image/png;base64,${faviconB64}`
  html = html.replace(
    /<link rel="icon"[^>]*>/,
    `<link rel="icon" type="image/png" href="${dataUri}">`
  )
  console.log(`  favicon.png inlined (${fmt(faviconB64.length * 0.75)})`)
}
console.log('\n[4/5] Packing inline app...')
const unpackedHtml = html
if (!process.argv.includes('--no-pack')) html = await packEsp32Html(html)
else console.log('  Packing disabled by --no-pack')

console.log('\n[5/5] Compressing with Zopfli...')
let gz = await gzipAsync(Buffer.from(html), { numiterations: 15 })
if (html !== unpackedHtml) {
  const unpackedGz = await gzipAsync(Buffer.from(unpackedHtml), { numiterations: 15 })
  if (gz.length < unpackedGz.length) {
    console.log(`  Packing saved ${unpackedGz.length - gz.length} bytes (${fmt(unpackedGz.length)} → ${fmt(gz.length)})`)
  } else {
    console.log('  Keeping the unpacked version because it compresses smaller')
    html = unpackedHtml
    gz = unpackedGz
  }
}
writeFileSync(htmlPath, html)
const outPath = 'dist/index.html.gz'
writeFileSync(outPath, gz)

hr()
const htmlBytes = Buffer.byteLength(html)
const ratio = ((1 - gz.length / htmlBytes) * 100).toFixed(1)
console.log(`Output      : ${outPath}`)
console.log(`Uncompressed: ${fmt(htmlBytes)}`)
console.log(`Compressed  : ${fmt(gz.length)}  (${ratio}% reduction)`)

if (gz.length > ESP32_SPIFFS_LIMIT) {
  console.warn(`\nWARNING: ${fmt(gz.length)} exceeds typical SPIFFS limit of ${fmt(ESP32_SPIFFS_LIMIT)}`)
  console.warn('   Consider reducing font imports or splitting code.')
} else {
  const pct = ((gz.length / ESP32_SPIFFS_LIMIT) * 100).toFixed(1)
  console.log(`ESP32 usage : ${pct}% of ${fmt(ESP32_SPIFFS_LIMIT)} limit`)
}
hr()
