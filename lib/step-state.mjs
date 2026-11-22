export const stepStateLabels = { planned: '计划', implemented: '有实现依据', verified: '已实际验证' }
export const verificationLabels = { passed: '通过', failed: '失败' }

export function stepState(node) {
  return node.state ?? (node.sources.length ? 'implemented' : 'planned')
}
