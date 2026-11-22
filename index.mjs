import { parseGraph } from './lib/graph.mjs'
import { exportObsidian } from './lib/obsidian.mjs'
import { workspaceStore } from './lib/dsh-store.mjs'
import { registerThreadlightSkills } from './lib/dsh-skill.mjs'
import { registerReviewPage } from './lib/dsh-review.mjs'

export const name = 'dsh-threadlight'
export const inject = ['tools', 'fs', 'workingDirectory']

const exportRoot = '.threadlight/obsidian'

function registerExport(ctx, policy) {
  ctx.effect(() => ctx.tools.register({
    name: 'threadlight_export',
    description: 'When requested by the user, export .threadlight/graph.json in this DSH session workspace to Obsidian Markdown and JSON Canvas. Returns the new or reused snapshot folder and overview canvas. Use the threadlight-map-project skill to author a graph if one is missing.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          directory: { type: 'string' }, overview: { type: 'string' },
          digest: { type: 'string' }, reused: { type: 'boolean' },
        },
        required: ['directory', 'overview', 'digest', 'reused'],
      },
      render: (_args, value) => [{ type: 'text', text:
        (value.reused ? '复用已有 Obsidian 快照。' : '已导出 Obsidian 快照。') +
        '\n工作区相对目录 ' + value.directory + '\n总览 ' + value.overview }],
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
        throw new Error('threadlight_export does not accept arguments')
      }
      if (!exec?.agent?.session) throw new Error('Threadlight requires an active DSH session')
      const signal = exec.signal
      signal?.throwIfAborted()
      const cwd = await ctx.workingDirectory.ensure(exec.agent, signal)
      const standing = policy?.resolve({ session: exec.agent.session })
      const store = await workspaceStore(ctx.fs, cwd, signal, standing)
      const raw = await store.readGraph()
      if (raw === null) throw new Error('Create .threadlight/graph.json in the current workspace before exporting')
      return exportObsidian(parseGraph(raw), store, { output: exportRoot, signal })
    },
  }), 'threadlight: export to Obsidian')
}

export function apply(ctx) {
  if (ctx.fs.sandboxMode === undefined) registerExport(ctx)
  else ctx.inject(['sandboxPolicy'], scoped => registerExport(scoped, scoped.sandboxPolicy))
  ctx.inject(['skills'], registerThreadlightSkills)
  ctx.inject(['webServer', 'connection', 'workspaceRegistry', 'llm', 'agentDefaultModel'], registerReviewPage)
}
