import { Input } from '@/registry/ui/input';
import type { ChangeEvent, ForwardRefRenderFunction, KeyboardEvent, RefObject } from 'react';
import { useState, useRef, useImperativeHandle, forwardRef, useMemo } from 'react';
import AutoSizeTextarea from 'react-textarea-autosize';
import { Key } from 'ts-keycode-enum';
import { fromDateInputValue, toDateInputValue } from '@/features/table/lib/dateFormatting';
import { GRID_DEFAULT } from '../../configs';
import type { ILinkCell, INumberCell, ITextCell } from '../../renderers';
import { CellType } from '../../renderers';
import type { IEditorRef, IEditorProps } from './EditorContainer';
import { TableDateCellEditor } from './TableDateCellEditor';

const { rowHeight: defaultRowHeight } = GRID_DEFAULT;

const TextEditorBase: ForwardRefRenderFunction<
  IEditorRef<ITextCell | INumberCell>,
  IEditorProps<ITextCell | INumberCell | ILinkCell>
> = (props, ref) => {
  const { cell, rect, style, theme, isEditing, onChange, setEditing } = props;
  const { cellLineColorActived } = theme;
  const { width, height } = rect;
  const { displayData, type } = cell;
  const inputType = type === CellType.Text ? (cell.inputType ?? 'text') : 'text';
  const usesDateInput = inputType === 'date' || inputType === 'datetime-local';
  const editingData = type === CellType.Text
    ? usesDateInput
      ? toDateInputValue(inputType, cell.data)
      : cell.data
    : displayData;
  const needWrap = (cell as ITextCell)?.isWrap;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLDivElement>(null);
  const [value, setValueInner] = useState(editingData);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    setValue: (value: string | number | null | undefined) => setValueInner(
      usesDateInput ? toDateInputValue(inputType, value) : String(value ?? ''),
    ),
    saveValue,
  }));

  const saveValue = () => {
    if (value === editingData || !isEditing) return;
    if (type === CellType.Number) {
      onChange?.(Number(value));
    } else if (usesDateInput) {
      onChange?.(fromDateInputValue(inputType, String(value ?? '')));
    } else {
      onChange?.(typeof value === 'string' ? value.trim() : value);
    }
  };

  const onChangeInner = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setValueInner(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { keyCode, shiftKey } = event;
    if (keyCode === Key.Enter && !shiftKey) {
      event.preventDefault();
    }
    if (keyCode === Key.Enter && shiftKey) {
      event.stopPropagation();
    }
  };

  const attachStyle = useMemo(() => {
    const style: React.CSSProperties = {
      width: width + 4,
      minHeight: height + 4,
      height: needWrap ? 'auto' : height + 4,
      marginLeft: -2,
      marginTop: -2,
      textAlign: cell.contentAlign ?? (type === CellType.Number ? 'right' : 'left'),
    };
    if (needWrap && height > defaultRowHeight) {
      style.paddingBottom = height - defaultRowHeight;
    }
    return style;
  }, [cell.contentAlign, type, height, width, needWrap]);

  if (usesDateInput) {
    return (
      <TableDateCellEditor
        ref={inputRef as RefObject<HTMLDivElement>}
        active={Boolean(isEditing)}
        inputType={inputType}
        value={String(value ?? '')}
        style={{
          border: `2px solid ${cellLineColorActived}`,
          ...style,
          ...attachStyle,
        }}
        onValueChange={setValueInner}
        onCommit={(next) => {
          onChange?.(fromDateInputValue(inputType, next));
          setEditing?.(false);
        }}
      />
    );
  }

  return (
    <>
      {needWrap ? (
        <div
          style={{
            ...style,
            ...attachStyle,
            paddingBottom: 16,
            border: `2px solid ${cellLineColorActived}`,
          }}
          className="relative rounded-md bg-background"
        >
          <AutoSizeTextarea
            ref={inputRef as RefObject<HTMLTextAreaElement>}
            className="w-full resize-none rounded border-none bg-background px-2 pt-1 text-[13px] leading-[1.4rem] focus-visible:outline-none"
            value={value}
            minRows={2}
            maxRows={5}
            onBlur={saveValue}
            onKeyDown={onKeyDown}
            onChange={onChangeInner}
          />
          <div className="absolute bottom-[2px] left-0 w-full rounded-b-md bg-background pb-[2px] pr-1 text-right text-xs text-slate-400 dark:text-slate-600">
            Shift + Enter
          </div>
        </div>
      ) : (
        <Input
          ref={inputRef as RefObject<HTMLInputElement>}
          variant="flat"
          style={{
            border: `2px solid ${cellLineColorActived}`,
            ...style,
            ...attachStyle,
          }}
          value={value}
          className="cursor-text border-2 text-[13px]"
          onChange={onChangeInner}
          onBlur={saveValue}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </>
  );
};

export const TextEditor = forwardRef(TextEditorBase);
