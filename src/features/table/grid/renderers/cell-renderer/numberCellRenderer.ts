import { GRID_DEFAULT } from '../../configs';
import { drawMultiLineText, drawProcessBar, drawRing } from '../base-renderer/baseRenderer';
import { CellType, NumberDisplayType } from './interface';
import type {
  INumberCell,
  ICellRenderProps,
  ICellMeasureProps,
  IInternalCellRenderer,
} from './interface';
import { getCenteredBlockTop, getTextBlockHeight } from './alignment';

const RING_RADIUS = 8.5;
const RING_LINE_WIDTH = 5;
const TEXT_GAP = 4;

const { maxRowCount, cellVerticalPaddingMD, cellHorizontalPadding, cellTextLineHeight } =
  GRID_DEFAULT;

export const numberCellRenderer: IInternalCellRenderer<INumberCell> = {
  type: CellType.Number,
  measure: (cell: INumberCell, props: ICellMeasureProps) => {
    const { displayData, showAs } = cell;
    const { width, height } = props;

    if (!displayData || typeof displayData === 'string' || showAs != null) {
      return { width, height, totalHeight: height };
    }

    const lineCount = displayData.length;
    const totalHeight = cellVerticalPaddingMD + lineCount * cellTextLineHeight;
    const displayRowCount = Math.min(maxRowCount, lineCount);

    return {
      width,
      height: Math.max(height, cellVerticalPaddingMD + displayRowCount * cellTextLineHeight),
      totalHeight,
    };
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  draw: (cell: INumberCell, props: ICellRenderProps) => {
    const { data, displayData, showAs, contentAlign = 'right' } = cell;

    if (data == null || displayData == null || displayData === '') return;

    const { ctx, rect, theme, isActive } = props;
    const { x, y, width, height } = rect;
    const { cellTextColor, fontSizeSM } = theme;
    const showText = showAs?.showValue ?? true;
    const isAlignLeft = contentAlign === 'left';
    const isAlignCenter = contentAlign === 'center';

    let textX = isAlignLeft
      ? x + cellHorizontalPadding
      : isAlignCenter
        ? x + width / 2
        : x + width - cellHorizontalPadding;
    let textMaxWidth = width - cellHorizontalPadding * 2;
    const isDataString = typeof displayData === 'string';
    const textLineCount = isDataString || !isActive ? 1 : displayData.length;
    const textTop = getCenteredBlockTop(
      height,
      getTextBlockHeight(textLineCount, fontSizeSM, cellTextLineHeight),
      cellVerticalPaddingMD,
    );

    if (showAs != null) {
      const { type, color, maxValue } = showAs;

      if (type === NumberDisplayType.Ring) {
        const totalRadius = RING_RADIUS + RING_LINE_WIDTH;
        const offsetX = isAlignLeft
          ? cellHorizontalPadding + totalRadius
          : width - cellHorizontalPadding - totalRadius;
        textX = isAlignLeft
          ? x + cellHorizontalPadding + 2 * totalRadius + TEXT_GAP
          : textX - 2 * totalRadius - TEXT_GAP;
        textMaxWidth = textMaxWidth - 2 * totalRadius - TEXT_GAP;

        drawRing(ctx, {
          x: x + offsetX,
          y: y + height / 2,
          value: data,
          maxValue,
          color,
          radius: RING_RADIUS,
          lineWidth: RING_LINE_WIDTH,
        });
      }

      if (type === NumberDisplayType.Bar) {
        const barHeight = 8;
        const textGap = 4;
        const halfMaxWidth = textMaxWidth / 2;
        const offsetX = isAlignLeft ? cellHorizontalPadding : width / 2;
        textX = isAlignLeft ? x + width / 2 + textGap : x + width / 2 - textGap;
        textMaxWidth = halfMaxWidth - textGap;

        drawProcessBar(ctx, {
          x: x + offsetX,
          y: y + (height - barHeight) / 2,
          width: halfMaxWidth,
          height: barHeight,
          value: data,
          maxValue,
          color,
        });
      }
    }

    if (!showText) return;

    if (isDataString || !isActive) {
      return drawMultiLineText(ctx, {
        x: textX,
        y: y + textTop,
        text: isDataString ? displayData : displayData.join(', '),
        maxLines: 1,
        maxWidth: textMaxWidth,
        fill: cellTextColor,
        fontSize: fontSizeSM,
        textAlign: contentAlign,
      });
    }

    let curY = y + textTop;
    displayData.forEach((text, index) => {
      const isLast = index === displayData.length - 1;
      drawMultiLineText(ctx, {
        x: textX,
        y: curY,
        text: isLast ? text : `${text},`,
        maxLines: 1,
        maxWidth: textMaxWidth,
        fill: cellTextColor,
        fontSize: fontSizeSM,
        textAlign: contentAlign,
      });
      curY += cellTextLineHeight;
    });
  },
};
