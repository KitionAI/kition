import type { IBaseCell } from './interface'

export type CellContentAlign = NonNullable<IBaseCell['contentAlign']>

export function getAlignedContentStart(
  origin: number,
  availableWidth: number,
  contentWidth: number,
  align: CellContentAlign,
) {
  if (align === 'right') return origin + Math.max(availableWidth - contentWidth, 0)
  if (align === 'center') return origin + Math.max((availableWidth - contentWidth) / 2, 0)
  return origin
}

export function getAlignedTextX(
  x: number,
  width: number,
  horizontalPadding: number,
  align: CellContentAlign,
) {
  if (align === 'right') return x + width - horizontalPadding
  if (align === 'center') return x + width / 2
  return x + horizontalPadding
}

export function getCenteredBlockTop(
  containerHeight: number,
  blockHeight: number,
  overflowTop = 0,
) {
  if (blockHeight > containerHeight) return overflowTop
  return Math.max((containerHeight - blockHeight) / 2, 0)
}

export function getTextBlockHeight(lineCount: number, fontSize: number, lineHeight: number) {
  if (lineCount <= 0) return 0
  return fontSize + (lineCount - 1) * lineHeight
}
