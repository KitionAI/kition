import type { BoardFrameSnapshot } from '@/types/designStart'
import { getBoardElementsWithDescendants, isBoardFrameElement } from './boardHierarchy'
import { getWhiteboardElementStyle } from './whiteboardStyle'
import type { WhiteboardColorToken, WhiteboardElement } from './whiteboardTypes'

/** Board palette tokens as flat colors a design can keep without the theme. */
const TOKEN_HEX: Record<WhiteboardColorToken, string> = {
  ink: '#1a1a1a',
  gray: '#8b8b8b',
  purple: '#5645d4',
  green: '#2a9d5c',
  orange: '#dd5b00',
  red: '#d0342c',
  yellow: '#f2c94c',
  blue: '#2b6cb0',
  white: '#ffffff',
}

/**
 * Captures a frame and everything inside it as a design-ready snapshot:
 * positions relative to the frame, palette tokens resolved to colors,
 * connectors and strokes left out because designs have no equivalent.
 */
export function boardFrameSnapshot(
  frame: WhiteboardElement,
  elements: readonly WhiteboardElement[],
): BoardFrameSnapshot | null {
  if (!isBoardFrameElement(frame)) return null
  const items: BoardFrameSnapshot['items'] = []
  for (const element of getBoardElementsWithDescendants(elements, [frame.id])) {
    if (element.id === frame.id) continue
    if (element.kind === 'image') {
      items.push({
        kind: 'image',
        x: element.x - frame.x,
        y: element.y - frame.y,
        width: element.width,
        height: element.height,
        workspacePath: element.workspacePath,
      })
    } else if (element.kind === 'text') {
      const fontSize = element.fontSize ?? 22
      items.push({
        kind: 'text',
        x: element.x - frame.x,
        y: element.y - frame.y,
        width: Math.max(fontSize, element.text.length * fontSize * 0.6),
        height: fontSize * 1.4,
        text: element.text,
        fontSize,
        fill: TOKEN_HEX[getWhiteboardElementStyle(element).strokeColor],
      })
    } else if (
      element.kind === 'rectangle' &&
      element.shapeStyle !== 'frame' &&
      element.shapeType !== 'frame' &&
      element.shapeStyle !== 'group'
    ) {
      const style = getWhiteboardElementStyle(element)
      items.push({
        kind: element.shapeType === 'ellipse' ? 'ellipse' : 'rectangle',
        x: element.x - frame.x,
        y: element.y - frame.y,
        width: element.width,
        height: element.height,
        text: element.text?.trim() || undefined,
        fill: style.fillStyle === 'none' ? '#ffffff' : TOKEN_HEX[style.fillColor],
        stroke: TOKEN_HEX[style.strokeColor],
        radius: element.shapeStyle === 'sticky' ? 4 : 12,
      })
    }
  }
  return {
    title: frame.text?.trim() || 'Frame',
    width: frame.width,
    height: frame.height,
    background: '#ffffff',
    items,
  }
}
