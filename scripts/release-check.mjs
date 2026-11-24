import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const fail = message => {
  console.error('release-check: ' + message)
  process.exitCode = 1
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ??
  (process.env.npm_package_version ? 'v' + process.env.npm_package_version : undefined)
if (!tag) {
  fail('缺少 tag。用法：GITHUB_REF_NAME=v0.1.0 node scripts/release-check.mjs')
  process.exit()
}

const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const expected = 'v' + manifest.version
if (tag !== expected) {
  fail('tag ' + JSON.stringify(tag) + ' 与 package.json version ' + JSON.stringify(manifest.version) + ' 不一致')
} else {
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
    fail('package-lock.json version 与 package.json 不一致，先运行 npm install --package-lock-only')
    process.exit()
  }
  const lines = (await readFile(new URL('CHANGELOG.md', root), 'utf8')).split(/\r?\n/)
  const heading = '## ' + manifest.version
  // The released section must be the first entry: "未发布" above a version means
  // the working tree carries changes that are not part of this tag.
  const start = lines.findIndex(line => /^## /.test(line))
  const current = start < 0 ? '' : lines[start].trim()
  if (!(current === heading || current.startsWith(heading + ' '))) {
    fail('CHANGELOG.md 顶部第一段必须是 "' + heading + '"（可带日期），实际是 "' + current + '"')
  } else {
    let end = lines.findIndex((line, index) => index > start && /^## /.test(line))
    if (end < 0) end = lines.length
    const body = lines.slice(start + 1, end).join('\n').trim()
    if (!body) fail('CHANGELOG.md 的 ' + heading + ' 段是空的')
    else {
      await writeFile(new URL('release-notes.md', root), '# ' + tag + '\n\n' + body + '\n')
      console.log('release-check: ' + tag + ' ok, notes written to release-notes.md')
    }
  }
}

if (process.exitCode) {
  console.error('release-check: 未通过，未生成发布说明')
}
