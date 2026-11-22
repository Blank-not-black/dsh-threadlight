import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const maxFileBytes = 4 * 1024 * 1024
const maxTotalBytes = 48 * 1024 * 1024
const supported = /\.(?:md|[mc]?js|jsx|ts|tsx|json5?|ya?ml|html|css|py|java|kts?|ets|rs|go|sh|ps1|toml|xml|gradle|sql|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|rb|php|swift|dart|vue|svelte)$/i
const credentialFile = /^(?:auth|tokens?|secrets?|credentials?|client[-_]secrets?|service[-_]account(?:[-_]key)?)\.(?:json5?|ya?ml|toml|xml)$/i
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function git(cwd, args) {
  return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout
}

function inspectable(path) {
  const parts = path.split('/')
  if (path.includes('\\') || /[\x00-\x1f:]/.test(path)) return false
  if (!parts.every((part, index) => part && (!part.startsWith('.') || index === 0 && part === '.github'))) return false
  if (parts.some(part => /^(?:node_modules|dist|out|build|vendor|coverage|secrets?|credentials?)$/i.test(part))) return false
  const leaf = basename(path)
  if (credentialFile.test(leaf) || /(?:\.min\.js|lock\.json|lock\.ya?ml)$/i.test(leaf)) return false
  return supported.test(leaf) || /^(?:Dockerfile|Makefile)$/i.test(leaf)
}

export async function repositoryRoot(directory) {
  return realpath((await git(directory, ['rev-parse', '--show-toplevel'])).trim())
}

export async function captureWorkspace(directory) {
  // Resolve once: callers may pass a short name, junction or symlinked path, and
  // the relative() check below only holds against the canonical root.
  const root = await realpath(directory)
  let head = null
  try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() } catch (error) {
    if (error.code !== 128) throw error
  }
  const names = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const files = new Map()
  const metadata = Object.create(null)
  let size = 0
  for (const path of [...new Set(names.split('\0').filter(inspectable))].sort()) {
    const candidate = resolve(root, path)
    let info
    try { info = await lstat(candidate) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.size > maxFileBytes) continue
    const actual = await realpath(candidate)
    const rel = relative(root, actual)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
    const current = await stat(actual)
    if (!current.isFile() || current.size > maxFileBytes) continue
    const content = await readFile(actual)
    if (content.includes(0) || content.length > maxFileBytes) continue
    let text
    try { text = decoder.decode(content) } catch { continue }
    size += content.length
    if (size > maxTotalBytes) throw new Error('The inspectable workspace exceeds 48 MiB')
    files.set(path, content)
    metadata[path] = {
      sha256: createHash('sha256').update(content).digest('hex'),
      lines: text.split(/\r\n|\r|\n/).length,
    }
  }
  const id = createHash('sha256').update(JSON.stringify([head, metadata])).digest('hex')
  return { id, head, files, metadata }
}

export function fileChanges(before, after) {
  if (!before) return []
  const changed = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[path]?.sha256 === after[path]?.sha256) continue
    changed.push({ path, kind: !before[path] ? 'added' : !after[path] ? 'removed' : 'modified' })
  }
  return changed
}
