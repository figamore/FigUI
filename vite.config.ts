import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import tailwindMangle from 'unplugin-tailwindcss-mangle/vite'
import { fileURLToPath } from 'url'

const mangleReservedPrefixes = [
  'btn-',
  'hl-',
  'resize-handle',
  'studio-',
  'probe-step-',
  'lucide',
]
const mangleReservedClasses = new Set([
  'dark',
  'light',
  'anthracite-dark',
  'midnight-dark',
])
const shouldMangleClass = (className: string) =>
  /[:-]/.test(className) &&
  !mangleReservedClasses.has(className) &&
  !mangleReservedPrefixes.some((prefix) => className.startsWith(prefix))

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      'react':             'preact/compat',
      'react-dom':         'preact/compat',
      'react-dom/client':  'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'lucide-react':      fileURLToPath(new URL('./src/icons.tsx', import.meta.url)),
    },
  },
  base: mode === 'demo' ? '/FigUI/' : '/',
  plugins: [
    react(),
    ...(mode === 'esp32' ? [
      tailwindMangle({
        filter: shouldMangleClass,
        generator: {
          classPrefix: '_',
        },
        registry: {
          file: '.tw-patch/tw-class-list.json',
        },
      }),
      viteSingleFile(),
    ] : []),
  ],
  build: {
    target: 'es2022',
    ...(mode === 'esp32' ? {
      // Favor transfer size over minifier speed for the firmware artifact.
      minify: 'terser',
      cssMinify: 'lightningcss',
      // Without a browser target LightningCSS assumes the newest engine and rewrites
      // `background-color: transparent` as `#0000`, which the tablet WebView drops —
      // bare buttons then fall back to the light UA ButtonFace.
      cssTarget: 'chrome61',
      modulePreload: { polyfill: false },
      terserOptions: {
        ecma: 2022,
        module: true,
        toplevel: true,
        compress: { passes: 3 },
        format: { comments: false },
      },
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    } : {}),
  },
}))
