import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'

/**
 * Anchor a floating panel (menu, popover, tooltip) to an element.
 * Returns a cleanup that stops tracking; call it when the panel closes.
 */
function position(anchor, floating, options = {}) {
  if (!anchor || !floating) return () => {}
  floating.style.position = 'fixed'
  return autoUpdate(anchor, floating, () => {
    void computePosition(anchor, floating, {
      placement: options.placement ?? 'bottom-start',
      strategy: 'fixed',
      middleware: [
        offset(options.offset ?? 4),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
      ],
    }).then(({ x, y }) => {
      floating.style.left = Math.round(x) + 'px'
      floating.style.top = Math.round(y) + 'px'
    })
  })
}

window.ThreadlightFloating = { available: true, position }
