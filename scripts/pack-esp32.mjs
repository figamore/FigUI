import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import lzma from 'lzma'
import { minify } from 'terser'

const require = createRequire(import.meta.url)
const decoder = readFileSync(require.resolve('lzma/src/lzma-d-min.js'), 'utf8')
const license = readFileSync(require.resolve('lzma/LICENSE'), 'utf8')

/** Pack only the single-file build's inline module; HTML and CSS stay native. */
export async function packEsp32Html(html) {
  const modules = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => /\btype\s*=\s*(["'])module\1/i.test(match[1]))
  if (modules.length !== 1 || /\bsrc\s*=/i.test(modules[0][1])) {
    throw new Error('ESP32 packing requires exactly one inline module script.')
  }
  const [original, attributes, source] = modules[0]
  if (!source.trim()) throw new Error('Cannot pack an empty application module.')

  const bytes = await new Promise((resolve, reject) => {
    lzma.compress(source, 3, (result, error) => error ? reject(error) : resolve(result))
  })
  const packed = Buffer.from(bytes)

  // Verify
  const codec = {}
  Function(decoder).call(codec)
  if (codec.LZMA.decompress(packed) !== source) {
    throw new Error('ESP32 packing failed its lossless round-trip check.')
  }

  const { code: loader } = await minify(`
    const packedScript = document.querySelector('script[data-figui-packed]');
    const codec = {};
    (function () { ${decoder} }).call(codec);
    function failed(error) {
      console.error('Could not unpack FigUI', error);
      const root = document.getElementById('root');
      if (root) root.textContent = 'Could not load FigUI. Please reload the page.';
    }
    try {
      const bytes = Uint8Array.from(atob('${packed.toString('base64')}'), c => c.charCodeAt(0));
      codec.LZMA.decompress(bytes, (source, error) => {
        if (error || typeof source !== 'string') { failed(error); return; }
        // Cloning an executed script also copies its "already started" flag,
        // so browsers will not execute the clone. Create a fresh module.
        const script = document.createElement('script');
        for (const { name, value } of packedScript.attributes) {
          if (name !== 'data-figui-packed') script.setAttribute(name, value);
        }
        script.nonce = packedScript.nonce;
        script.textContent = source;
        script.onerror = failed;
        packedScript.after(script);
        packedScript.remove();
      });
    } catch (error) { failed(error); }
  `, { ecma: 2022, module: true, format: { comments: false } })

  return html.replace(original, () => `<script${attributes} data-figui-packed>/* LZMA-JS (MIT)\n${license}*/\n${loader}</script>`)
}
