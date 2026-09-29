import { designTextLayout } from './designTextLayout'
import type { DesignNode } from './designTypes'

const MIN_FONT_SIZE = 4

/**
 * The largest font size, down from the current one, at which the text's
 * wrapped lines fit the layer's height. Measurement is injectable so the
 * search stays testable without a canvas.
 */
export function fitDesignTextFontSize(
  node: DesignNode,
  layout: (node: DesignNode) => Array<{ text: string }> = designTextLayout,
): number {
  const fits = (fontSize: number) =>
    layout({ ...node, fontSize }).length * fontSize * node.lineHeight <= node.height + 0.5
  if (fits(node.fontSize)) return node.fontSize
  let low = MIN_FONT_SIZE,
    high = node.fontSize
  while (high - low > 0.5) {
    const middle = (low + high) / 2
    if (fits(middle)) low = middle
    else high = middle
  }
  return Math.max(MIN_FONT_SIZE, Math.floor(low))
}
