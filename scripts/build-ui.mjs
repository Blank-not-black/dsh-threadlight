import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dist = new URL('../dist/', import.meta.url)
await mkdir(dist, { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL('../src/dsh-floating.js', import.meta.url))],
  outfile: fileURLToPath(new URL('dsh-floating.js', dist)),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  banner: { js: '/*! Includes @floating-ui/dom under the MIT license. */' },
})
