export function layoutColumns(flow) {
  if (flow.layout) return flow.layout.rows
  const remaining = new Map(flow.nodes.map(({ id }) => [id, 0]))
  const next = new Map(flow.nodes.map(({ id }) => [id, []]))
  for (const { from, to } of flow.edges) {
    remaining.set(to, remaining.get(to) + 1)
    next.get(from).push(to)
  }
  const columns = []
  let frontier = flow.nodes.map(({ id }) => id).filter(id => remaining.get(id) === 0)
  while (frontier.length) {
    columns.push(frontier)
    const ready = []
    for (const id of frontier) {
      remaining.delete(id)
      for (const target of next.get(id)) {
        const count = remaining.get(target) - 1
        remaining.set(target, count)
        if (count === 0) ready.push(target)
      }
    }
    frontier = ready
  }
  // Cyclic steps, such as a retry loop, keep their stable input order.
  for (const id of remaining.keys()) columns.push([id])
  return columns
}
