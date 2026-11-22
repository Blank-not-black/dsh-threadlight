import { resolve } from 'node:path'
import { draftIdPattern } from './flow-draft.mjs'

export const reportDirectory = 'implementation'

export function reportPath(repository, id, version) {
  if (typeof id !== 'string' || !draftIdPattern.test(id) || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid implementation report draft identity')
  }
  return resolve(repository, '.threadlight', reportDirectory, id, version + '.json')
}

export function includeImplementationReport(prompt, repository) {
  const separator = prompt.indexOf('\n\n')
  const context = prompt.slice(separator + 2)
  const { draft: id, version, desired } = JSON.parse(context)
  const path = reportPath(repository, id, version)
  const report = {
    schemaVersion: 1, draft: { id, version }, generatedAt: '2026-11-22T04:30:00.000Z',
    summary: '实现摘要', steps: [{
      step: desired.nodes[0].id, state: 'verified', sources: [{ path: 'lib/x.mjs', kind: 'source', line: 12 }],
      verification: [{ id: 'check', at: '2026-11-22T04:29:00.000Z', result: 'passed', summary: '实际结果', command: 'npm run check' }],
      divergence: '与预期的差异',
    }],
  }
  return [
    prompt.slice(0, separator),
    '实现完成后，创建所需的父目录并将 UTF-8 JSON 实现报告写入 ' + path + '。',
    '参照以下结构填写实际时间、仓库相对源码路径及草稿中的步骤 ID，每个步骤只写一次。状态可填 planned、implemented 或 verified。',
    '只记录真正执行过的验证，未运行则省略 verification。只有至少一项通过时才填 verified 并写入验证记录。若仅有失败，将实际结果写入 divergence。summary、divergence 和 command 可按需省略。',
    JSON.stringify(report), '', context,
  ].join('\n')
}
