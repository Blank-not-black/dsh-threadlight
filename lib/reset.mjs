import { lstat, mkdir, readFile, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { graphFile, graphDigest } from './graph-source.mjs'
import { lock, safeDirectory } from './refresh.mjs'

const publicationFiles = ['state.json', 'viewer.html', 'revisions', 'history.json', 'changes.md']

async function entry(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A graph.json whose digest matches the absorbed publication is only a mirror of
// it, so it archives with the publication and the next refresh rebuilds from
// source. A hand-written or not-yet-absorbed working graph is kept.
async function absorbedWorkingGraph(control) {
  if (!await entry(join(control, graphFile))) return false
  let state
  try {
    state = JSON.parse(await readFile(join(control, 'state.json'), 'utf8'))
  } catch {
    return false
  }
  if (typeof state?.absorbedGraphDigest !== 'string') return false
  try {
    return graphDigest(await readFile(join(control, graphFile), 'utf8')) === state.absorbedGraphDigest
  } catch {
    return false
  }
}

async function createArchive(control) {
  const directory = join(control, 'archive')
  await safeDirectory(directory)
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
  for (let suffix = 0; ; suffix++) {
    const name = timestamp + (suffix ? '-' + suffix : '')
    try {
      await mkdir(join(directory, name))
      return 'archive/' + name
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

export async function resetDocumentation(root) {
  const control = join(root, '.threadlight')
  const empty = { archived: null, moved: [], next: 'refresh' }
  if (!await entry(control)) return empty
  await safeDirectory(control)
  const release = await lock(control)
  try {
    const names = []
    for (const name of publicationFiles) {
      if (await entry(join(control, name))) names.push(name)
    }
    // Keep a hand-written or unpublished working graph; archive the mirror so
    // the next refresh really rebuilds from scratch.
    if (await absorbedWorkingGraph(control)) names.push(graphFile)
    if (!names.length) return empty
    const archived = await createArchive(control)
    const directory = join(control, archived)
    const moved = []
    try {
      for (const name of names) {
        await rename(join(control, name), join(directory, name))
        moved.push(name)
      }
    } catch (error) {
      // Restore the active publication if a later rename fails.
      const rolledBack = await Promise.allSettled(moved.reverse().map(name =>
        rename(join(directory, name), join(control, name))))
      const failures = rolledBack.filter(result => result.status === 'rejected')
      if (failures.length) throw new Error('Reset rollback incomplete; check ' + archived, { cause: error })
      await rmdir(directory)
      throw error
    }
    return { archived: '.threadlight/' + archived, moved, next: 'refresh' }
  } finally {
    await release()
  }
}
