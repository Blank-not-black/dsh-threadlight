import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const provider = 'dsh-threadlight'
const descriptions = {
  'threadlight-map-project': 'Map a local project from user-visible features to implementation and test evidence, then export the graph to Obsidian when requested.',
  'threadlight-document-project': 'Create or incrementally revise Threadlight project documentation in its dedicated DSH session using a captured Git workspace and a reviewed path-change list.',
}

export function registerThreadlightSkills(ctx) {
  const skills = ctx.skills
  if (typeof skills?.registerProvider !== 'function') return
  const entries = Object.entries(descriptions).map(([name, description]) => {
    const path = fileURLToPath(new URL('../skills/' + name + '/SKILL.md', import.meta.url))
    const content = readFileSync(path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    return {
      skill: { name, description, invocation: { userInvocable: true, modelInvocable: true },
        provider, source: 'bundled', path, resourceBase: { kind: 'directory', path: dirname(path) } },
      content,
    }
  })
  ctx.effect(() => skills.registerProvider(() => ({
    name: provider,
    list: async () => entries.map(({ skill }) => ({ ...skill, rank: 600, locator: skill.path })),
    get: async candidate => {
      const entry = entries.find(({ skill }) => skill.name === candidate.name)
      return entry && { ...entry.skill, content: entry.content }
    },
  })), 'threadlight: document and mapping skills')
}
