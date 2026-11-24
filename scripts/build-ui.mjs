import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dist = new URL('../dist/', import.meta.url)
const bundled = ['@floating-ui/dom', '@floating-ui/core', '@floating-ui/utils']
await mkdir(dist, { recursive: true })
const licenses = []
for (const name of bundled) {
  const manifest = JSON.parse(await readFile(new URL('../node_modules/' + name + '/package.json', import.meta.url), 'utf8'))
  const license = await readFile(new URL('../node_modules/' + name + '/LICENSE', import.meta.url), 'utf8')
  licenses.push('========== ' + name + ' ' + manifest.version + ', MIT ==========\n\n' + license.trimEnd())
}
await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('../src/dsh-floating.js', import.meta.url))],
    outfile: fileURLToPath(new URL('dsh-floating.js', dist)),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    banner: { js: '/*! Includes ' + bundled.join(', ') + ' under the MIT license. License: floating-ui-LICENSE.txt */' },
  }),
  writeFile(new URL('floating-ui-LICENSE.txt', dist), licenses.join('\n\n') + '\n', 'utf8'),
])
