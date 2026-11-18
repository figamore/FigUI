import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { packEsp32Html, gzipSmallestHtml } from './pack-esp32.mjs'

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
const candidates = [{ name: 'unpacked', html }]
if (!process.argv.includes('--no-pack')) {
  candidates.push({ name: 'ASCII dictionary', html: await packEsp32Html(html, { packStyles: true }) })
  const unicode = { packStyles: true, unicodeDictionary: true }
  const unicodeHtml = await packEsp32Html(html, unicode)
  candidates.push({ name: 'Unicode dictionary', html: unicodeHtml })
  const groupedHtml = await packEsp32Html(html, { ...unicode, separateStrings: true })
  if (groupedHtml !== unicodeHtml) candidates.push({ name: 'Unicode dictionary with grouped strings', html: groupedHtml })
} else console.log('  Packing disabled by --no-pack')

console.log('\n[5/5] Compressing with Zopfli...')
const selected = await gzipSmallestHtml(candidates)
html = selected.html
const gz = selected.gz
for (const { name, bytes } of selected.sizes) console.log(`  ${name}: ${bytes} bytes (${fmt(bytes)})`)
console.log(`  Selected ${selected.name}; saved ${selected.sizes[0].bytes - gz.length} bytes versus unpacked`)
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
