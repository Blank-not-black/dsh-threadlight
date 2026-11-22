import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dist = new URL('../dist/', import.meta.url)
const [license, notice] = await Promise.all([
  readFile(new URL('./LICENSE', import.meta.resolve('@maxgraph/core/package.json')), 'utf8'),
  readFile(new URL('./maxgraph-NOTICE.txt', import.meta.url), 'utf8'),
])
await mkdir(dist, { recursive: true })
await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('../src/draft-diagram.js', import.meta.url))],
    outfile: fileURLToPath(new URL('draft-diagram.js', dist)),
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    banner: { js: '/*! Includes maxGraph under Apache-2.0. License and notices: maxgraph-LICENSE.txt */' },
  }),
  writeFile(new URL('maxgraph-LICENSE.txt', dist), license.trimEnd() + '\n\n' + notice, 'utf8'),
])
