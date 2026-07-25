import { GRID_DEFAULT } from '../../configs';
import { drawMultiLineText } from '../base-renderer/baseRenderer';
import { CellRegionType, CellType } from './interface';
import type {
  ICellClickCallback,
  IInternalCellRenderer,
  ITextCell,
  ICellRenderProps,
  ICellMeasureProps,
} from './interface';
import {
  getAlignedTextX,
  getCenteredBlockTop,
  getTextBlockHeight,
} from './alignment';

const { maxRowCount, cellHorizontalPadding, cellVerticalPaddingMD, cellTextLineHeight } =
  GRID_DEFAULT;

export const textCellRenderer: IInternalCellRenderer<ITextCell> = {
  type: CellType.Text,
  needsHoverPosition: true,
  measure: (cell: ITextCell, props: ICellMeasureProps) => {
    const { displayData } = cell;
    const { ctx, theme, width, height } = props;
    const { cellTextColor, fontSizeSM, fontFamily } = theme;

    if (!displayData) {
      return { width, height, totalHeight: height };
    }

    ctx.font = `${fontSizeSM}px ${fontFamily}`;

    const lineCount = drawMultiLineText(ctx, {
      text: displayData,
      maxLines: Infinity,
      lineHeight: cellTextLineHeight,
      maxWidth: width - cellHorizontalPadding * 2,
      fill: cellTextColor,
      needRender: false,
    }).length;

    const totalHeight = cellVerticalPaddingMD + lineCount * cellTextLineHeight;
    const displayRowCount = Math.min(maxRowCount, lineCount);

    return {
      width,
      height: Math.max(height, cellVerticalPaddingMD + displayRowCount * cellTextLineHeight),
      totalHeight,
    };
  },
  draw: (cell: ITextCell, props: ICellRenderProps) => {
    const { displayData, contentAlign = 'left' } = cell;
    const { ctx, rect, theme, isActive } = props;
    const { x, y, width, height } = rect;

    if (!displayData) return;

    const { cellTextColor, fontSizeSM } = theme;
    const renderHeight = height - cellVerticalPaddingMD;
    const maxLines = isActive ? Infinity : Math.max(Math.floor(renderHeight / cellTextLineHeight), 1);
    const lines = drawMultiLineText(ctx, {
      text: displayData,
      maxLines,
      lineHeight: cellTextLineHeight,
      maxWidth: width - cellHorizontalPadding * 2,
      fill: cellTextColor,
      fontSize: fontSizeSM,
      needRender: false,
    });
    const textTop = getCenteredBlockTop(
      height,
      getTextBlockHeight(lines.length, fontSizeSM, cellTextLineHeight),
      cellVerticalPaddingMD,
    );

    drawMultiLineText(ctx, {
      x: getAlignedTextX(x, width, cellHorizontalPadding, contentAlign),
      y: y + textTop,
      text: displayData,
      maxLines,
      lineHeight: cellTextLineHeight,
      maxWidth: width - cellHorizontalPadding * 2,
      fill: cellTextColor,
      fontSize: fontSizeSM,
      textAlign: contentAlign,
    });
  },
  onClick: (cell: ITextCell, _props, callback: ICellClickCallback) => {
    if (!cell.readonly && cell.isEditingOnClick) {
      callback({ type: CellRegionType.ToggleEditing, data: null });
    }
  },
};
