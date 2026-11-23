import { createHash } from 'node:crypto'
import { parseGraph } from './lib/graph.mjs'
import { exportObsidian } from './lib/obsidian.mjs'
import { workspaceStore } from './lib/dsh-store.mjs'
import { registerThreadlightSkills } from './lib/dsh-skill.mjs'
import { registerReviewPage } from './lib/dsh-review.mjs'
import { normalizeQuery, queryGraph } from './lib/graph-query.mjs'
import { buildAnnotation, writeAnnotation } from './lib/tool-annotations.mjs'

export const name = 'dsh-threadlight'
export const inject = ['tools', 'fs', 'workingDirectory']

const exportRoot = '.threadlight/obsidian'
const revisionPattern = /^threadlight-[0-9a-f]{16}$/

function activeSession(exec) {
  if (!exec?.agent?.session) throw new Error('Threadlight requires an active DSH session')
  return exec.agent
}

// The published graph lives in revisions/<revision>/graph.json; a workspace
// without state.json keeps the hand-written .threadlight/graph.json fallback.
async function readWorkspaceGraph(store) {
  const state = await store.read('.threadlight/state.json')
  let raw
  if (state !== null) {
    let revision
    try { revision = JSON.parse(state)?.revision } catch {}
    if (typeof revision !== 'string' || !revisionPattern.test(revision)) {
      throw new Error('工作区的 Threadlight 状态文件无效，请刷新图谱。')
    }
    raw = await store.read('.threadlight/revisions/' + revision + '/graph.json')
    if (raw === null) throw new Error('找不到 Threadlight 状态文件指向的图谱，请刷新图谱。')
  } else {
    raw = await store.read('.threadlight/graph.json')
  }
  if (raw === null) throw new Error('工作区还没有 Threadlight 图谱。')
  let graph
  try { graph = parseGraph(raw) } catch (error) {
    throw new Error('当前工作区的 Threadlight 图谱无效：' + error.message)
  }
  return { graph, raw, digest: createHash('sha256').update(raw).digest('hex') }
}

const graphParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {
      type: 'string', enum: ['overview', 'flow', 'step', 'search'],
      description: 'What to read: overview (default list view), flow (one flow with steps and edges), step (one step with details and source references), or search (flows and steps matching term).',
    },
    group: { type: 'string', description: 'Feature-area (module) id, for view=flow or view=step.' },
    flow: { type: 'string', description: 'Flow id, for view=flow or view=step.' },
    step: { type: 'string', description: 'Step id, for view=step.' },
    term: { type: 'string', description: 'Case-insensitive keyword matched against flow and step titles and summaries, for view=search.' },
  },
}

const graphOutputSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        view: { type: 'string', const: 'overview' },
        project: { type: 'string' },
        counts: {
          type: 'object', additionalProperties: false,
          properties: {
            areas: { type: 'integer' }, groups: { type: 'integer' },
            flows: { type: 'integer' }, steps: { type: 'integer' },
          },
          required: ['areas', 'groups', 'flows', 'steps'],
        },
        areas: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { id: { type: 'string' }, title: { type: 'string' }, groups: { type: 'integer' } },
            required: ['id', 'title', 'groups'],
          },
        },
        groups: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' }, title: { type: 'string' },
              area: { type: 'string' }, flows: { type: 'integer' },
            },
            required: ['id', 'title', 'flows'],
          },
        },
        flows: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              group: { type: 'string' }, flow: { type: 'string' },
              title: { type: 'string' }, steps: { type: 'integer' },
            },
            required: ['group', 'flow', 'title', 'steps'],
          },
        },
        truncated: { type: 'boolean' },
      },
      required: ['view', 'project', 'counts', 'areas', 'groups', 'flows', 'truncated'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        view: { type: 'string', const: 'flow' },
        group: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, title: { type: 'string' } },
          required: ['id', 'title'],
        },
        flow: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
          },
          required: ['id', 'title', 'summary'],
        },
        steps: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
              state: { type: 'string', enum: ['planned', 'implemented', 'verified'] },
              sources: { type: 'integer' },
            },
            required: ['id', 'title', 'summary', 'state', 'sources'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              from: { type: 'string' }, to: { type: 'string' },
              kind: { type: 'string', enum: ['sequence', 'branch', 'merge'] },
              label: { type: 'string' },
            },
            required: ['from', 'to', 'kind'],
          },
        },
        truncated: { type: 'boolean' },
      },
      required: ['view', 'group', 'flow', 'steps', 'edges', 'truncated'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        view: { type: 'string', const: 'step' },
        group: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, title: { type: 'string' } },
          required: ['id', 'title'],
        },
        flow: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, title: { type: 'string' } },
          required: ['id', 'title'],
        },
        step: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
            details: { type: 'array', items: { type: 'string' } },
            state: { type: 'string', enum: ['planned', 'implemented', 'verified'] },
            stateLabel: { type: 'string' },
            divergence: { type: 'string' },
            verification: {
              type: 'object', additionalProperties: false,
              properties: {
                total: { type: 'integer' }, passed: { type: 'integer' }, failed: { type: 'integer' },
                latest: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    at: { type: 'string' },
                    result: { type: 'string', enum: ['passed', 'failed'] },
                    summary: { type: 'string' }, command: { type: 'string' },
                  },
                  required: ['at', 'result', 'summary'],
                },
              },
              required: ['total', 'passed', 'failed'],
            },
            sources: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  kind: { type: 'string', enum: ['source', 'test', 'documentation', 'workflow'] },
                  line: { type: 'integer' }, symbol: { type: 'string' },
                },
                required: ['path', 'kind'],
              },
            },
          },
          required: ['id', 'title', 'summary', 'details', 'state', 'stateLabel', 'verification', 'sources'],
        },
      },
      required: ['view', 'group', 'flow', 'step'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        view: { type: 'string', const: 'search' },
        term: { type: 'string' },
        flows: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { group: { type: 'string' }, flow: { type: 'string' }, title: { type: 'string' } },
            required: ['group', 'flow', 'title'],
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              group: { type: 'string' }, flow: { type: 'string' },
              step: { type: 'string' }, title: { type: 'string' },
            },
            required: ['group', 'flow', 'step', 'title'],
          },
        },
        truncated: { type: 'boolean' },
      },
      required: ['view', 'term', 'flows', 'steps', 'truncated'],
    },
  ],
}

const annotationTargetSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['group', 'flow', 'step'] },
    flow: { type: 'string' },
    step: { type: 'string' },
  },
  required: ['kind'],
}

const annotateParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    group: { type: 'string', description: 'Feature-area (module) id that owns the feedback; must exist in the current graph.' },
    text: { type: 'string', description: 'Feedback text, 1 to 3000 characters.' },
    target: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['group', 'flow', 'step'], description: 'Annotation target kind; defaults to group.' },
        flow: { type: 'string', description: 'Flow id when kind is flow or step.' },
        step: { type: 'string', description: 'Step id when kind is step.' },
      },
      required: ['kind'],
      description: 'Optional annotation target; defaults to the whole feature area.',
    },
    quote: { type: 'string', description: 'Optional exact selected text to keep with the annotation, at most 3000 characters.' },
  },
  required: ['group', 'text'],
}

const annotateOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' },
    group: { type: 'string' },
    target: annotationTargetSchema,
    createdAt: { type: 'string' },
  },
  required: ['id', 'group', 'target', 'createdAt'],
}

function textContent(text) {
  return [{ type: 'text', text }]
}

function graphRender(_args, value) {
  if (value.view === 'overview') {
    const { counts } = value
    return textContent(value.project + '：' + counts.areas + ' 个领域、' + counts.groups +
      ' 个功能区、' + counts.flows + ' 条线路、' + counts.steps + ' 个步骤。' +
      (value.truncated ? '线路列表已截断。' : ''))
  }
  if (value.view === 'flow') {
    return textContent('线路「' + value.flow.title + '」：' + value.steps.length + ' 个步骤、' +
      value.edges.length + ' 条连线。' + (value.truncated ? '列表已截断。' : ''))
  }
  if (value.view === 'step') {
    return textContent('步骤「' + value.step.title + '」：' + value.step.stateLabel +
      '，' + value.step.sources.length + ' 条源码引用、' + value.step.details.length + ' 条详情。')
  }
  return textContent('搜索「' + value.term + '」：' + value.flows.length + ' 条线路、' +
    value.steps.length + ' 个步骤。' + (value.truncated ? '结果已截断。' : ''))
}

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

function registerGraph(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'threadlight_graph',
    description: 'Read the Threadlight graph of the current DSH session workspace as a compact structure instead of the whole graph.json. Use view=overview (default) for areas, feature areas and flows; view=flow with group and flow for steps and edges; view=step with group, flow and step for details and source references; view=search with term to find flows and steps by keyword.',
    parameters: graphParameters,
    output: { schema: graphOutputSchema, render: graphRender },
    timeoutMs: 30000,
    async execute(args, exec) {
      const agent = activeSession(exec)
      normalizeQuery(args ?? {})
      const signal = exec.signal
      signal?.throwIfAborted()
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      const store = await workspaceStore(ctx.fs, cwd, signal)
      const { graph } = await readWorkspaceGraph(store)
      return queryGraph(graph, args ?? {})
    },
  }), 'threadlight: read graph')
}

function registerAnnotate(ctx, policy) {
  ctx.effect(() => ctx.tools.register({
    name: 'threadlight_annotate',
    description: 'Record user feedback as a Threadlight annotation in the current DSH session workspace so it appears in the Threadlight annotations inbox. group is an existing feature-area (module) id; target optionally narrows the annotation to a flow or step; quote optionally keeps the exact selected text. Fails when the workspace has no Threadlight graph or the target does not exist.',
    parameters: annotateParameters,
    output: {
      schema: annotateOutputSchema,
      render: (_args, value) => textContent('已记录批注 ' + value.id + '（功能区 ' + value.group + '）。'),
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const agent = activeSession(exec)
      const signal = exec.signal
      signal?.throwIfAborted()
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      const standing = policy?.resolve({ session: agent.session })
      const store = await workspaceStore(ctx.fs, cwd, signal, standing)
      const { graph, digest } = await readWorkspaceGraph(store)
      const record = buildAnnotation(graph, {
        group: args?.group, text: args?.text, target: args?.target, quote: args?.quote, digest,
      })
      let saved
      try {
        saved = await writeAnnotation(store, record, { signal })
      } catch (error) {
        if (error instanceof Error && ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(error.code)) {
          throw new Error('当前 DSH 权限不允许写入这个工作区。')
        }
        throw error
      }
      return { id: saved.id, group: saved.module, target: saved.target, createdAt: saved.createdAt }
    },
  }), 'threadlight: record annotation')
}

function registerNativeTools(ctx, policy) {
  registerExport(ctx, policy)
  registerGraph(ctx)
  registerAnnotate(ctx, policy)
}

export function apply(ctx) {
  if (ctx.fs.sandboxMode === undefined) registerNativeTools(ctx)
  else ctx.inject(['sandboxPolicy'], scoped => registerNativeTools(scoped, scoped.sandboxPolicy))
  ctx.inject(['skills'], registerThreadlightSkills)
  ctx.inject(['webServer', 'connection', 'workspaceRegistry', 'llm', 'agentDefaultModel'], registerReviewPage)
}
