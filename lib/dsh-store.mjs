import { MAX_GRAPH_BYTES } from './graph.mjs'

const graphPath = '.threadlight/graph.json'

export async function workspaceStore(fs, cwd, signal, policy) {
  const root = await fs.resolve('.', { cwd, signal })
  async function resolveTarget(relativePath, type = 'file') {
    const segments = relativePath.split('/')
    for (let index = 0; index < segments.length; index++) {
      const partial = segments.slice(0, index + 1).join('/')
      const info = await fs.lstat(partial, { cwd }, signal)
      const expectedType = index === segments.length - 1 ? type : 'directory'
      if (info && info.type !== expectedType) throw new Error('Unexpected workspace path type at ' + partial)
    }
    const target = await fs.resolve(relativePath, { cwd, signal })
    if (!fs.contains(root, target)) throw new Error('Threadlight path must stay within the current workspace')
    return target
  }

  async function read(path, limit) {
    const target = await resolveTarget(path)
    if (!await fs.stat(target, signal)) return null
    const bytes = await fs.readBytes(target, signal, limit)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  return {
    readGraph: () => read(graphPath, MAX_GRAPH_BYTES),
    read: path => read(path, 48 * 1024 * 1024),
    async list(path) {
      const target = await resolveTarget(path, 'directory')
      if (!await fs.stat(target, signal)) return []
      return fs.listDir(target, signal)
    },
    async create(path, content) {
      const target = await resolveTarget(path)
      try {
        await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)
        return true
      } catch (error) {
        if (error.code === 'FS_NOT_OBSERVED') return false
        throw error
      }
    },
  }
}
