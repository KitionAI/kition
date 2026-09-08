import type { DesignNode } from './designTypes'
let context: CanvasRenderingContext2D | null = null
export function designTextLayout(node: DesignNode) {
  context ||=
    typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null
  const font = `${node.fontWeight} ${node.fontSize}px "${node.fontFamily}"`
  if (context) context.font = font
  const measure = (text: string) =>
    (context?.measureText(text).width ?? text.length * node.fontSize * 0.6) +
    Math.max(0, Array.from(text).length - 1) * node.letterSpacing
  const lines: string[] = []
  for (const paragraph of node.text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    // Word boundaries preserve spaces and support scripts without spaces.
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'word' }).segment(paragraph),
      (s) => s.segment,
    )
    for (const word of segments) {
      if (measure(line + word) <= node.width) {
        line += word
        continue
      }
      if (line) {
        lines.push(line.trimEnd())
        line = ''
      }
      if (measure(word) <= node.width) {
        line = word.trimStart()
        continue
      }
      for (const char of Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
          word,
        ),
        (s) => s.segment,
      )) {
        if (line && measure(line + char) > node.width) {
          lines.push(line)
          line = ''
        }
        line += char
      }
    }
    lines.push(line)
  }
  const metrics = context?.measureText('Mg'),
    ascent = metrics?.fontBoundingBoxAscent ?? node.fontSize * 0.9
  const descent = metrics?.fontBoundingBoxDescent ?? node.fontSize * 0.2
  const lineHeight = node.fontSize * node.lineHeight
  const baseline = (lineHeight - ascent - descent) / 2 + ascent
  return lines.map((text, index) => ({
    text,
    x:
      node.textAlign === 'center'
        ? node.width / 2
        : node.textAlign === 'right'
          ? node.width
          : 0,
    y: baseline + index * lineHeight,
  }))
}
