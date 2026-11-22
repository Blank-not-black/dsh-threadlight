import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function readTextFile(path, maxBytes, signal) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readBytesFile(path, maxBytes, signal))
}

export async function readBytesFile(path, maxBytes, signal) {
  signal?.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Expected a regular file')
    if (info.size > maxBytes) throw new Error('File exceeds the size limit')
    const chunks = []
    let size = 0
    for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false, signal })) {
      size += chunk.length
      if (size > maxBytes) throw new Error('File exceeds the size limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally {
    await handle.close()
  }
}

async function entry(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function createLocalStore(path) {
  await mkdir(path, { recursive: true })
  const root = await realpath(path)

  async function target(relativePath, createParents) {
    let directory = root
    const segments = relativePath.split('/')
    const name = segments.pop()
    for (const segment of segments) {
      directory = join(directory, segment)
      if (createParents) {
        try { await mkdir(directory) } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      const info = await entry(directory)
      if (!info) return null
      if (!info.isDirectory()) throw new Error('Export directory must be a real directory')
    }
    return join(directory, name)
  }

  return {
    async read(relativePath, signal) {
      const file = await target(relativePath, false)
      if (!file) return null
      const info = await entry(file)
      if (!info) return null
      if (!info.isFile()) throw new Error('Export path must be a regular file')
      return readTextFile(file, 48 * 1024 * 1024, signal)
    },
    async create(relativePath, content, signal) {
      signal?.throwIfAborted()
      const file = await target(relativePath, true)
      const pending = join(dirname(file), '.threadlight-' + randomUUID() + '.tmp')
      const handle = await open(pending, 'wx', 0o600)
      try {
        try { await handle.writeFile(content, { signal }) } finally { await handle.close() }
        signal?.throwIfAborted()
        try { await link(pending, file) } catch (error) {
          if (error.code === 'EEXIST') return false
          throw error
        }
        return true
      } finally {
        try { await unlink(pending) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    },
  }
}
