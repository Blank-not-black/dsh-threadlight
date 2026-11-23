import { GeometryChange, Graph, HierarchicalLayout, ImageBox, InternalEvent, Point, TerminalChange } from '@maxgraph/core'

const nodeWidth = 216
const nodeHeight = 96
const autoEdgeStyle = 'manhattanEdgeStyle'
const manualEdgeStyle = 'segmentEdgeStyle'
const wireIcon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"%3E%3Ccircle cx="9" cy="9" r="8" fill="%23225e48" stroke="white"/%3E%3Cpath d="M5 9h8M9 5v8" stroke="white" stroke-width="1.5"/%3E%3C/svg%3E'
const nodeStyle = {
  rounded: true, arcSize: 14, fillColor: 'var(--panel)', strokeColor: 'var(--accent)',
  strokeWidth: 1.25, fontColor: 'var(--ink)', fontSize: 13, spacing: 8, resizable: false,
}
const edgeStyle = {
  strokeColor: 'var(--accent)', strokeWidth: 1.55, endArrow: 'block', endSize: 7,
  fontColor: 'var(--ink)', fontSize: 12, labelBackgroundColor: 'var(--paper)',
  editable: false, movable: false,
}

function shortened(text, max) {
  const characters = [...text.trim().replace(/\s+/g, ' ')]
  return characters.length > max ? characters.slice(0, max - 1).join('') + '…' : characters.join('')
}

/**
 * Break one field into whole-character lines. The diagram is an editing
 * surface, so a node shows the readable head of its title and summary instead
 * of one clipped line; `max` is tuned to the node width at the default font.
 * @param {string} text - field value.
 * @param {number} max - characters per line.
 * @param {number} lines - maximum line count.
 * @returns {string[]} wrapped lines, the last one ellipsized when cut.
 */
function wrapped(text, max, lines) {
  const characters = [...String(text ?? '').trim().replace(/\s+/g, ' ')]
  const result = []
  for (let index = 0; index < characters.length && result.length < lines; index += max) {
    result.push(characters.slice(index, index + max).join(''))
  }
  if (characters.length > max * lines && result.length) {
    result[result.length - 1] = [...result[result.length - 1]].slice(0, max - 1).join('') + '…'
  }
  return result
}

function nodeLabel(node) {
  const title = wrapped(node.title || '未命名步骤', 13, 2)
  const summary = wrapped(node.summary, 17, 3)
  return [...title, ...summary].join('\n')
}

function boundedPoint({ x, y }) {
  const round = value => Math.max(-100000, Math.min(100000, Math.round(value)))
  return { x: round(x), y: round(y) }
}

function place(cell, position, model) {
  const geometry = cell.getGeometry().clone()
  Object.assign(geometry, position)
  model.setGeometry(cell, geometry)
}

function legacyWaypoint(bend, source, target, width) {
  const from = source.getGeometry(), to = target.getGeometry()
  const bottom = from.y + from.height, start = bottom + (to.y <= bottom ? 10 : 0)
  return { x: bend.x * width, y: start + (to.y - 10 - start) * Math.max(.14, Math.min(.86, bend.y)) }
}

export function createDraftDiagram(container, callbacks) {
  const graph = new Graph(container)
  const model = graph.getDataModel(), parent = graph.getDefaultParent()
  const nodes = new Map(), edges = new Map(), targets = new WeakMap()
  const fitPlugin = graph.getPlugin('fit')
  let plan, topology, positioned, updating = false

  graph.setCellsEditable(false)
  graph.setCellsCloneable(false)
  graph.setCellsResizable(false)
  graph.setEdgeLabelsMovable(false)
  graph.setAllowLoops(false)
  graph.setAllowDanglingEdges(false)
  graph.setDisconnectOnMove(false)
  graph.setDropEnabled(false)
  graph.setAllowNegativeCoordinates(false)
  graph.setPanning(true)
  graph.setConnectable(true)
  graph.getSelectionModel().setSingleSelection(true)
  graph.getStylesheet().getDefaultEdgeStyle().edgeStyle = autoEdgeStyle
  graph.getView().setTranslate(30, 26)
  fitPlugin.minFitScale = .45
  fitPlugin.maxFitScale = 1
  const connector = graph.getPlugin('ConnectionHandler')
  connector.connectImage = new ImageBox(wireIcon, 18, 18)
  connector.getIconPosition = (icon, state) => new Point(
    state.x + state.width - icon.bounds.width - 4,
    state.getCenterY() - icon.bounds.height / 2,
  )
  // The native handlers use this for both a new connection and reconnecting an endpoint.
  graph.validateEdge = (cell, source, target) => {
    const from = targets.get(source)?.step, to = targets.get(target)?.step
    const id = targets.get(cell)?.edge
    const kind = plan.edges.find(edge => edge.id === id)?.kind ?? 'sequence'
    if (plan.edges.some(edge => edge.id !== id && edge.from === from && edge.to === to && edge.kind === kind)) {
      return '这两个步骤之间已经有同类型连线。'
    }
    return null
  }
  graph.validationAlert = message => callbacks.message(message)

  function afterInteraction(callback) {
    const visiblePlan = plan
    queueMicrotask(() => { if (visiblePlan === plan && !updating) callback() })
  }

  function select(selection) {
    const cell = nodes.get(selection.step) ?? edges.get(selection.edge) ?? null
    if (graph.getSelectionCell() === cell) return
    if (cell) graph.setSelectionCell(cell)
    else graph.clearSelection()
  }

  graph.getSelectionModel().addListener(InternalEvent.CHANGE, () => {
    if (updating) return
    const cell = graph.getSelectionCell()
    const selection = cell ? targets.get(cell) : {}
    if (selection) afterInteraction(() => callbacks.select(selection))
  })

  connector.addListener(InternalEvent.CONNECT, (_, event) => {
    const cell = event.getProperty('cell')
    const from = targets.get(cell.getTerminal(true))?.step
    const to = targets.get(cell.getTerminal(false))?.step
    afterInteraction(() => {
      updating = true
      try { graph.removeCells([cell]) } finally { updating = false }
      if (from && to) callbacks.connect(from, to)
    })
  })

  model.addListener(InternalEvent.CHANGE, (_, event) => {
    if (updating) return
    const geometries = new Set(), terminals = new Set()
    for (const change of event.getProperty('changes')) {
      if (!targets.has(change.cell)) continue
      if (change instanceof GeometryChange) geometries.add(change.cell)
      if (change instanceof TerminalChange) terminals.add(change.cell)
    }
    const moved = [...geometries].some(cell => cell.isVertex())
    const connections = new Map()
    for (const cell of terminals) {
      connections.set(targets.get(cell).edge, {
        from: targets.get(cell.getTerminal(true))?.step, to: targets.get(cell.getTerminal(false))?.step,
      })
    }
    for (const cell of geometries) {
      if (!cell.isEdge() || terminals.has(cell)) continue
      const id = targets.get(cell).edge
      connections.set(id, { waypoints: (cell.getGeometry().points ?? []).slice(0, 64).map(boundedPoint) })
    }
    if (moved || connections.size) {
      const positions = moved ? [...nodes].map(([step, cell]) => ({ step, ...boundedPoint(cell.getGeometry()) })) : null
      afterInteraction(() => callbacks.edit(positions, connections))
    }
  })

  const directions = new Map([
    ['ArrowLeft', [-8, 0]], ['ArrowRight', [8, 0]], ['ArrowUp', [0, -8]], ['ArrowDown', [0, 8]],
  ])
  container.addEventListener('keydown', event => {
    const cell = graph.getSelectionCell()
    const direction = directions.get(event.key)
    if (!cell?.isEdge() || !direction || event.altKey || event.ctrlKey || event.metaKey) return
    const points = [...(cell.getGeometry().points ?? [])]
    if (!points.length) {
      const view = graph.getView()
      const path = view.getState(cell)?.absolutePoints
      if (!path || path.length < 2) return
      const index = Math.floor(path.length / 2)
      const from = path[index - 1], to = path[index]
      points.push(new Point((from.x + to.x) / (2 * view.scale) - view.translate.x,
        (from.y + to.y) / (2 * view.scale) - view.translate.y))
    }
    event.preventDefault()
    const [dx, dy] = direction
    points[0] = boundedPoint({ x: points[0].x + dx, y: points[0].y + dy })
    callbacks.edit(null, new Map([[targets.get(cell).edge, { waypoints: points }]]))
  })

  function rebuild(next) {
    graph.removeCells([...edges.values(), ...nodes.values()], false)
    nodes.clear()
    edges.clear()
    for (const node of next.nodes) {
      const cell = graph.insertVertex({ parent, value: '', position: [0, 0], size: [nodeWidth, nodeHeight], style: nodeStyle })
      targets.set(cell, { step: node.id })
      nodes.set(node.id, cell)
    }
    for (const edge of next.edges) {
      const cell = graph.insertEdge({ parent, value: '', source: nodes.get(edge.from), target: nodes.get(edge.to) })
      targets.set(cell, { edge: edge.id })
      edges.set(edge.id, cell)
    }

    if (nodes.size) {
      const layout = new HierarchicalLayout(graph, 'north')
      layout.interRankCellSpacing = 78
      layout.intraCellSpacing = 46
      layout.disableEdgeStyle = false
      layout.useBoundingBox = false
      layout.execute(parent)
      const saved = new Map(next.layout?.map(position => [position.step, position]))
      const occupied = [...saved.values()]
      for (const [step, cell] of nodes) {
        const position = saved.get(step)
        if (position) place(cell, { x: position.x, y: position.y }, model)
        else if (saved.size) {
          const { x, y } = cell.getGeometry()
          const overlaps = occupied.some(spot => Math.abs(spot.x - x) < nodeWidth + 12 && Math.abs(spot.y - y) < nodeHeight + 12)
          const available = overlaps ? Math.max(...occupied.map(spot => spot.x)) + nodeWidth + 46 : x
          const nextPosition = boundedPoint({ x: available, y })
          place(cell, nextPosition, model)
          occupied.push(nextPosition)
        }
      }
    }
  }

  function render(next, selection, { reset = false } = {}) {
    const structure = JSON.stringify([next.nodes.map(node => node.id), next.edges.map(({ id, from, to }) => [id, from, to])])
    updating = true
    plan = next
    try {
      graph.batchUpdate(() => {
        if (reset || structure !== topology || positioned && !next.layout?.length) rebuild(next)
        topology = structure
        positioned = Boolean(next.layout?.length)
        for (const node of next.nodes) {
          const cell = nodes.get(node.id)
          const label = nodeLabel(node)
          if (cell.getValue() !== label) model.setValue(cell, label)
        }
        const width = Math.max(container.clientWidth - 60, ...[...nodes.values()].map(cell => {
          const { x, width } = cell.getGeometry()
          return x + width
        }), nodeWidth)
        for (const edge of next.edges) {
          const cell = edges.get(edge.id)
          const label = shortened(edge.label, 18) || (edge.kind === 'branch' ? '条件待填写' : '')
          if (cell.getValue() !== label) model.setValue(cell, label)
          const points = edge.waypoints ?? (edge.bend
            ? [legacyWaypoint(edge.bend, nodes.get(edge.from), nodes.get(edge.to), width)]
            : [])
          const routing = points.length ? manualEdgeStyle : autoEdgeStyle
          const dashed = edge.kind === 'branch'
          if (cell.getStyle().edgeStyle !== routing || cell.getStyle().dashed !== dashed) {
            model.setStyle(cell, { ...edgeStyle, dashed, edgeStyle: routing })
          }
          const current = cell.getGeometry()
          if ((current.points?.length ?? 0) !== points.length ||
            points.some((point, index) => point.x !== current.points[index]?.x || point.y !== current.points[index]?.y)) {
            const geometry = current.clone()
            geometry.points = points.length ? points.map(({ x, y }) => new Point(x, y)) : null
            model.setGeometry(cell, geometry)
          }
        }
      })
      select(selection)
      if (reset) fit()
    } finally { updating = false }
  }

  function fit() {
    if (nodes.size && container.clientWidth) fitPlugin.fit({ border: 24 })
  }

  return { render, fit, zoom: delta => delta > 0 ? graph.zoomIn() : graph.zoomOut() }
}
