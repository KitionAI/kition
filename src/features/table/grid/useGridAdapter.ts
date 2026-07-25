import { useCallback, useMemo } from 'react';
import type { DataField, DataRecord, DataRecordValue } from '@/types/dataDocument';
import { displayValue, normalizeAttachmentValue } from '@/features/table/lib/tableEditorShared';
import { formatTableFieldValue } from '@/features/table/lib/dateFormatting';
import type { IGridColumn, ICellItem } from './interface';
import { CellType } from './renderers';
import type { ICell, IInnerCell } from './renderers';

const DEFAULT_COLUMN_WIDTH = 200;

type CellEditedHandler = (record: DataRecord, field: DataField, value: DataRecordValue) => void;

type RowExpandHandler = (record: DataRecord) => void;
type RowAppendHandler = (targetIndex?: number) => void;
type ColumnAppendHandler = () => void;
type ColumnResizeHandler = (field: DataField, width: number, colIndex: number) => void;
type ColumnOrderedHandler = (field: DataField, fromIndex: number, toIndex: number) => void;
type RowOrderedHandler = (
  sourceRecords: DataRecord[],
  targetRecord: DataRecord | null,
  insertIndex: number
) => void;
type AttachmentPreviewHandler = (record: DataRecord, field: DataField, attachmentIndex: number) => void;
type CellAIActionHandler = (record: DataRecord, field: DataField) => void;
type DocumentOpenHandler = (path: string) => void;

export interface IGridAdapterArgs {
  visibleFields: DataField[];
  sortedAndFilteredRecords: DataRecord[];
  columnWidths?: Record<string, number>;
  tableId?: number;
  onCellEdited: CellEditedHandler;
  onRowExpand?: RowExpandHandler;
  onRowAppend?: RowAppendHandler;
  onColumnAppend?: ColumnAppendHandler;
  onColumnResize?: ColumnResizeHandler;
  onColumnOrdered?: ColumnOrderedHandler;
  onRowOrdered?: RowOrderedHandler;
  onPreviewAttachment?: AttachmentPreviewHandler;
  onCellAIAction?: CellAIActionHandler;
  onOpenDocument?: DocumentOpenHandler;
}

function toSelectChoices(field: DataField) {
  const choices = Array.isArray(field.options?.choices) ? field.options!.choices! : [];
  return choices.map((name) => ({ id: name, name }));
}

function valuesToDisplayList(value: DataRecordValue | unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).filter(Boolean) as string[];
  const text = displayValue(value);
  return text ? [text] : [];
}

function fieldToColumn(field: DataField, width: number): IGridColumn {
  return {
    id: String(field.id),
    name: field.title || field.name,
    width,
    hasMenu: true,
    readonly: field.readonly,
    isPrimary: field.is_primary,
    description: field.title,
  };
}

export function buildCellForField(
  field: DataField,
  record: DataRecord,
  onPreviewAttachmentIndex?: (index: number) => void,
  onOpenDocument?: DocumentOpenHandler,
): ICell {
  const raw = record.values?.[field.name] ?? null;
  const display = displayValue(raw);

  switch (field.type) {
    case 'number': {
      const data = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      return {
        type: CellType.Number,
        data,
        displayData: data == null ? '' : String(data),
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'checkbox': {
      return {
        type: CellType.Boolean,
        data: Boolean(raw),
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'single_select': {
      const list = valuesToDisplayList(raw).slice(0, 1);
      const choices = toSelectChoices(field);
      const choiceMap: Record<string, { id: string; name: string }> = {};
      for (const choice of choices) choiceMap[choice.id] = choice;
      return {
        type: CellType.Select,
        data: list,
        displayData: list,
        choiceMap,
        choiceSorted: choices,
        isMultiple: false,
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'multi_select': {
      const list = valuesToDisplayList(raw);
      const choices = toSelectChoices(field);
      const choiceMap: Record<string, { id: string; name: string }> = {};
      for (const choice of choices) choiceMap[choice.id] = choice;
      return {
        type: CellType.Select,
        data: list,
        displayData: list,
        choiceMap,
        choiceSorted: choices,
        isMultiple: true,
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'attachment': {
      const attachments = normalizeAttachmentValue(raw);
      const data = attachments.map((item, index) => ({
        id: `${field.id}-${index}`,
        url: item.url,
      }));
      return {
        type: CellType.Image,
        data,
        displayData: attachments.map((item) => item.name),
        contentAlign: 'center',
        readonly: field.readonly,
        onPreview: onPreviewAttachmentIndex
          ? (activeId: string) => {
              const idx = data.findIndex((item) => item.id === activeId);
              if (idx >= 0) onPreviewAttachmentIndex(idx);
            }
          : undefined,
        aiConfigEnabled: Boolean(field.ai_config?.enabled),
      };
    }
    case 'long_text': {
      return {
        type: CellType.Text,
        data: display,
        displayData: display,
        isWrap: true,
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'rating': {
      const options = (field.options ?? {}) as Record<string, unknown>;
      const max = Number(options.max ?? 5);
      const iconRaw = typeof options.icon === 'string' ? (options.icon as string) : 'star';
      const data = Math.max(0, Math.min(Number.isFinite(max) ? max : 5, Number(raw ?? 0)));
      return {
        type: CellType.Rating,
        data,
        icon: iconRaw,
                                                          
                                         
        color: '#f59e0b',
        max: Number.isFinite(max) && max > 0 ? Math.min(max, 10) : 5,
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'link_to_record': {
      const refs = Array.isArray(raw) ? raw : [];
      const labels = refs
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const ref = item as { display?: unknown; row_key?: unknown };
          return typeof ref.display === 'string' ? ref.display : typeof ref.row_key === 'string' ? ref.row_key : '';
        })
        .filter(Boolean);
      return {
        type: CellType.Link,
        data: labels,
        displayData: labels.join(', '),
        contentAlign: 'center',
        readonly: true,
      };
    }
    case 'document_link': {
      return {
        type: CellType.Link,
        data: display ? [display] : [],
        displayData: display,
        contentAlign: 'center',
        readonly: true,
        onClick: onOpenDocument && display ? () => onOpenDocument(display) : undefined,
      };
    }
    case 'user':
    case 'created_by':
    case 'last_modified_by': {
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const users = list
        .map((item, index): { id: string; name: string; avatarUrl?: string } | null => {
          if (item && typeof item === 'object') {
            const ref = item as { id?: unknown; name?: unknown; avatar?: unknown };
            return {
              id: typeof ref.id === 'string' ? ref.id : `user-${index}`,
              name: typeof ref.name === 'string' ? ref.name : typeof ref.id === 'string' ? ref.id : 'User',
              avatarUrl: typeof ref.avatar === 'string' ? ref.avatar : undefined,
            };
          }
          const text = displayValue(item);
          return text ? { id: `user-${index}`, name: text } : null;
        })
        .filter((user): user is { id: string; name: string; avatarUrl?: string } => user !== null);
      return {
        type: CellType.User,
        data: users,
        displayData: users.map((user) => user.name).join(', '),
        contentAlign: 'center',
        readonly: true,
      };
    }
    case 'button': {
      const options = (field.options ?? {}) as Record<string, unknown>;
      const label = typeof options.label === 'string' && options.label ? (options.label as string) : field.title || 'Run';
      return {
        type: CellType.Button,
        data: {
          cellValue: { count: 0 },
          fieldOptions: { label, color: 'blue' as never },
          tableId: '',
        },
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    case 'created_time':
    case 'last_modified_time': {
      return {
        type: CellType.Text,
        data: display,
        displayData: formatTableFieldValue(field, raw),
        contentAlign: 'center',
        readonly: true,
      };
    }
    case 'auto_number':
    case 'lookup':
    case 'rollup':
      return {
        type: CellType.Text,
        data: display,
        displayData: display,
        contentAlign: 'center',
        readonly: true,
      };
    case 'text':
    case 'url':
    case 'formula': {
      return {
        type: CellType.Text,
        data: display,
        displayData: display,
        contentAlign: 'center',
        readonly: field.readonly || field.type === 'formula',
      };
    }
    case 'date':
    case 'datetime': {
      return {
        type: CellType.Text,
        data: display,
        displayData: formatTableFieldValue(field, raw),
        inputType: field.type === 'date' ? 'date' : 'datetime-local',
        isEditingOnClick: true,
        contentAlign: 'center',
        readonly: field.readonly,
      };
    }
    default:
      return {
        type: CellType.Text,
        data: display,
        displayData: display,
        contentAlign: 'center',
        readonly: field.readonly || field.type === 'formula',
      };
  }
}

export function readCellValue(field: DataField, cell: IInnerCell): DataRecordValue {
  switch (cell.type) {
    case CellType.Number:
      return cell.data ?? null;
    case CellType.Boolean:
      return Boolean(cell.data);
    case CellType.Rating:
      return typeof cell.data === 'number' && Number.isFinite(cell.data) ? cell.data : 0;
    case CellType.Select: {
                                                                               
                                                             
                                      
      const raw = cell.data as unknown;
      const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const items = arr.map((item) => (typeof item === 'string' ? item : (item as { title: string }).title));
      if (field.type === 'single_select') return items[0] ?? null;
      return items;
    }
    case CellType.Image:
      return cell.data.map((item) => ({ name: item.url.split('/').pop() || item.url, url: item.url }));
    case CellType.Text:
    case CellType.Link:
      return typeof cell.data === 'string' ? cell.data : (cell.data?.[0] ?? '');
    default:
      return null;
  }
}

export function useGridAdapter(args: IGridAdapterArgs) {
  const {
    visibleFields,
    sortedAndFilteredRecords,
    columnWidths,
    onCellEdited,
    onRowExpand,
    onRowAppend,
    onColumnAppend,
    onColumnResize,
    onColumnOrdered,
    onRowOrdered,
    onPreviewAttachment,
    onCellAIAction,
    onOpenDocument,
  } = args;

  const columns = useMemo<IGridColumn[]>(() => {
    return visibleFields.map((field) =>
      fieldToColumn(field, columnWidths?.[String(field.id)] ?? DEFAULT_COLUMN_WIDTH)
    );
  }, [visibleFields, columnWidths]);

  const rowCount = sortedAndFilteredRecords.length;

  const getCellContent = useCallback(
    (cell: ICellItem): ICell => {
      const [columnIndex, rowIndex] = cell;
      const field = visibleFields[columnIndex];
      const record = sortedAndFilteredRecords[rowIndex];
      if (!field || !record) return { type: CellType.Loading };
      const previewHook =
        field.type === 'attachment' && onPreviewAttachment
          ? (index: number) => onPreviewAttachment(record, field, index)
          : undefined;
      return buildCellForField(field, record, previewHook, onOpenDocument);
    },
    [visibleFields, sortedAndFilteredRecords, onPreviewAttachment, onOpenDocument]
  );

  const handleCellEdited = useCallback(
    (cell: ICellItem, newValue: IInnerCell) => {
      const [columnIndex, rowIndex] = cell;
      const field = visibleFields[columnIndex];
      const record = sortedAndFilteredRecords[rowIndex];
      if (!field || !record) return;
      onCellEdited(record, field, readCellValue(field, newValue));
    },
    [visibleFields, sortedAndFilteredRecords, onCellEdited]
  );

  const handleRowExpand = useCallback(
    (rowIndex: number) => {
      const record = sortedAndFilteredRecords[rowIndex];
      if (record && onRowExpand) onRowExpand(record);
    },
    [sortedAndFilteredRecords, onRowExpand]
  );

  const handleColumnResize = useCallback(
    (column: IGridColumn, newSize: number, colIndex: number) => {
      const field = visibleFields[colIndex];
      if (field && onColumnResize) onColumnResize(field, newSize, colIndex);
    },
    [visibleFields, onColumnResize]
  );

  const handleColumnOrdered = useCallback(
    (dragColIndexCollection: number[], dropColIndex: number) => {
      if (!onColumnOrdered) return;
      const sourceIndex = dragColIndexCollection[0];
      const field = visibleFields[sourceIndex];
      if (field) onColumnOrdered(field, sourceIndex, dropColIndex);
    },
    [visibleFields, onColumnOrdered]
  );

  const handleRowOrdered = useCallback(
    (dragRowIndexCollection: number[], dropRowIndex: number) => {
      if (!onRowOrdered) return;
      const sourceRecords = dragRowIndexCollection
        .map((index) => sortedAndFilteredRecords[index])
        .filter((record): record is DataRecord => Boolean(record));
      const targetRecord = sortedAndFilteredRecords[dropRowIndex] ?? null;
      onRowOrdered(sourceRecords, targetRecord, dropRowIndex);
    },
    [sortedAndFilteredRecords, onRowOrdered]
  );

  const handleCellAIAction = useCallback(
    (cell: ICellItem) => {
      if (!onCellAIAction) return;
      const [columnIndex, rowIndex] = cell;
      const field = visibleFields[columnIndex];
      const record = sortedAndFilteredRecords[rowIndex];
      if (!field || !record) return;
      if (!field.ai_config?.enabled) return;
      onCellAIAction(record, field);
    },
    [visibleFields, sortedAndFilteredRecords, onCellAIAction]
  );

  return {
    columns,
    rowCount,
    getCellContent,
    onCellEdited: handleCellEdited,
    onRowExpand: handleRowExpand,
    onRowAppend,
    onColumnAppend,
    onColumnResize: handleColumnResize,
    onColumnOrdered: handleColumnOrdered,
    onRowOrdered: handleRowOrdered,
    onCellAIAction: handleCellAIAction,
  };
}
