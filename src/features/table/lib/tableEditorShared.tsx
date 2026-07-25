import {
  CalendarDays,
  Check,
  CircleDot,
  FileText,
  Hash,
  Link2,
  Star,
  Table2,
  User,
  Workflow,
  GalleryHorizontalEnd,
  KanbanSquare,
} from 'lucide-react'
import { loadDesktopSettings } from '@/services/desktopSettings'
import { LinearRowType, type IGroupPoint, type IGroupCollection, type IGridColumn } from '@/features/table/grid/interface'
import { CellType, type ICell } from '@/features/table/grid/renderers/cell-renderer/interface'
import type { RuntimeWritingModel } from '@/types'
import type {
  DataAttachment,
  DataField,
  DataFieldOptions,
  DataFieldType,
  DataRecord,
  DataRecordValue,
  DataView,
  DataViewType,
} from '@/types/dataDocument'
import type { DesktopProviderKind } from '@/types/desktopSettings'
import type { AnyAIConfig } from '@/types/aiConfig'
export {
  createEmptyFilterCondition,
  createEmptyFilterGroup,
  countFilterConditions,
  evaluateFilterTree,
  filterTreeHasActiveCondition,
} from '@/features/table/filter'
export type { FilterConjunction, FilterOperator } from '@/features/table/filter'
import type { FilterCondition, FilterGroup, FilterNode } from '@/features/table/filter'
export type DataInlineFilterCondition = FilterCondition
export type DataInlineFilterGroup = FilterGroup
export type DataInlineFilterNode = FilterNode

export const fieldTypes: Array<{ value: DataFieldType; label: string; labelKey: string }> = [
  { value: 'text', label: 'Text', labelKey: 'fieldTypes.text' },
  { value: 'long_text', label: 'Long text', labelKey: 'fieldTypes.longText' },
  { value: 'number', label: 'Number', labelKey: 'fieldTypes.number' },
  { value: 'date', label: 'Date', labelKey: 'fieldTypes.date' },
  { value: 'datetime', label: 'Datetime', labelKey: 'fieldTypes.datetime' },
  { value: 'single_select', label: 'Select', labelKey: 'fieldTypes.singleSelect' },
  { value: 'multi_select', label: 'Multi select', labelKey: 'fieldTypes.multiSelect' },
  { value: 'checkbox', label: 'Checkbox', labelKey: 'fieldTypes.checkbox' },
  { value: 'rating', label: 'Rating', labelKey: 'fieldTypes.rating' },
  { value: 'url', label: 'URL', labelKey: 'fieldTypes.url' },
  { value: 'attachment', label: 'Attachment', labelKey: 'fieldTypes.attachment' },
  { value: 'document_link', label: 'Document', labelKey: 'fieldTypes.documentLink' },
  { value: 'user', label: 'User', labelKey: 'fieldTypes.user' },
  { value: 'link_to_record', label: 'Link to record', labelKey: 'fieldTypes.linkToRecord' },
  { value: 'lookup', label: 'Lookup', labelKey: 'fieldTypes.lookup' },
  { value: 'rollup', label: 'Rollup', labelKey: 'fieldTypes.rollup' },
  { value: 'formula', label: 'Formula', labelKey: 'fieldTypes.formula' },
  { value: 'button', label: 'Button', labelKey: 'fieldTypes.button' },
  { value: 'auto_number', label: 'Auto number', labelKey: 'fieldTypes.autoNumber' },
  { value: 'created_time', label: 'Created time', labelKey: 'fieldTypes.createdTime' },
  { value: 'last_modified_time', label: 'Last modified time', labelKey: 'fieldTypes.lastModifiedTime' },
  { value: 'created_by', label: 'Created by', labelKey: 'fieldTypes.createdBy' },
  { value: 'last_modified_by', label: 'Last modified by', labelKey: 'fieldTypes.lastModifiedBy' },
]

export type DataInlineViewMode = DataViewType
export type SortDirection = 'asc' | 'desc'
export type ToolbarPanel = 'hidden' | 'filter' | 'sort' | 'group' | 'cover' | 'field' | 'rowHeight' | 'freeze' | null
export type ImagePreviewState = { items: DataAttachment[]; index: number } | null
export type RowDropPosition = 'before' | 'after'
export type RecordContextMenuState = { recordId: number; x: number; y: number } | null
export type ColumnHeaderMenuState = { fieldId: number; x: number; y: number } | null
export type DataInlineSortItem = {
  id: string
  field_name: string
  direction: SortDirection
}
export type DataInlineGroupItem = {
  id: string
  field_name: string
  direction: SortDirection
}
export type DataInlineViewConfig = {
  hidden_field_names?: string[]
  filter?: { field_name?: string; operator?: string; value?: string }
  filter_tree?: DataInlineFilterGroup
  sort?: { field_name?: string; direction?: SortDirection }
  sort_items?: DataInlineSortItem[]
  group_field_name?: string
  group_items?: DataInlineGroupItem[]
  cover_field_name?: string
  row_height?: GridRowHeightKey
  frozen_column_count?: number
  search_query?: string
}
export type GridCellSelection = { recordId: number | null; fieldName: string } | null
export type DataRecordWindow = { limit?: number; offset?: number }

export type GridRowHeightKey = 'short' | 'medium' | 'tall' | 'extra_tall'

export const gridRowHeightPresets: Record<GridRowHeightKey, number> = {
  short: 32,
  medium: 40,
  tall: 56,
  extra_tall: 88,
}

export function resolveGridRowHeight(key?: GridRowHeightKey | null): number {
  return gridRowHeightPresets[key ?? 'medium'] ?? gridRowHeightPresets.medium
}

export const gridRowHeight = 40
export const gridRowNumberColumnWidth = 48
export const gridFieldColumnWidth = 180
export const gridAddColumnWidth = 180
export const gridRecordPageSize = 300
export const gridRecordOverscanRows = 16
export const maxVirtualGridCanvasHeight = 16_000_000

export const selectPalette = ['green', 'blue', 'yellow', 'red', 'purple', 'gray'] as const
export const fieldColorTones = [
  { value: 'slate', label: 'Slate', labelKey: 'colorTones.slate' },
  { value: 'amber', label: 'Amber', labelKey: 'colorTones.amber' },
  { value: 'sky', label: 'Sky', labelKey: 'colorTones.sky' },
  { value: 'violet', label: 'Violet', labelKey: 'colorTones.violet' },
  { value: 'emerald', label: 'Emerald', labelKey: 'colorTones.emerald' },
  { value: 'cyan', label: 'Cyan', labelKey: 'colorTones.cyan' },
  { value: 'blue', label: 'Blue', labelKey: 'colorTones.blue' },
  { value: 'rose', label: 'Rose', labelKey: 'colorTones.rose' },
] as const

const fieldToneByType: Partial<Record<DataFieldType, string>> = {
  text: 'slate',
  long_text: 'slate',
  number: 'amber',
  date: 'sky',
  datetime: 'sky',
  single_select: 'violet',
  multi_select: 'violet',
  checkbox: 'emerald',
  url: 'cyan',
  document_link: 'blue',
}

export const viewTypeOptions: Array<{ type: DataInlineViewMode; label: string; labelKey: string }> = [
  { type: 'grid', label: 'Grid view', labelKey: 'viewTypes.grid' },
  { type: 'gallery', label: 'Gallery view', labelKey: 'viewTypes.gallery' },
  { type: 'kanban', label: 'Kanban view', labelKey: 'viewTypes.kanban' },
  { type: 'calendar', label: 'Calendar view', labelKey: 'viewTypes.calendar' },
  { type: 'form', label: 'Form view', labelKey: 'viewTypes.form' },
]

export function getViewTypeLabelKey(type: DataInlineViewMode) {
  return viewTypeOptions.find((item) => item.type === type)?.labelKey || 'viewTypes.fallback'
}

export function normalizeLegacyViewTitle(view: Pick<DataView, 'title' | 'type'>) {
  const title = (view.title || '').trim()
  if (view.type === 'grid' && ['all tasks', 'all messages'].includes(title.toLowerCase())) {
    return viewTypeOptions.find((item) => item.type === 'grid')?.label || 'Grid view'
  }
  return title
}

export function getFieldTypeLabelKey(type: DataFieldType) {
  return fieldTypes.find((item) => item.value === type)?.labelKey
}

export function getViewTypeLabel(type: DataInlineViewMode) {
  return viewTypeOptions.find((item) => item.type === type)?.label || 'View'
}

export function getViewIcon(type: DataInlineViewMode, className = 'size-4') {
  if (type === 'kanban') return <KanbanSquare className={className} />
  if (type === 'calendar') return <CalendarDays className={className} />
  if (type === 'gallery') return <GalleryHorizontalEnd className={className} />
  if (type === 'form') return <FileText className={className} />
  return <Table2 className={className} />
}

export function nextViewTitle(type: DataInlineViewMode, views: DataView[]) {
  const baseTitle = getViewTypeLabel(type)
  const sameTypeCount = views.filter((view) => view.type === type).length
  return sameTypeCount > 0 ? `${baseTitle} ${sameTypeCount + 1}` : baseTitle
}

export function parseMarker(content: string) {
  try {
    const value = JSON.parse(content) as { data_document_id?: number; id?: number }
    return Number(value.data_document_id || value.id || 0) || null
  } catch {
    return null
  }
}

export function displayValue(value: DataRecordValue | unknown) {
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).filter(Boolean).join(', ')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record.name || record.title || record.display || record.url || record.href || record.row_key || '')
  }
  if (value === null || value === undefined) return ''
  return String(value)
}

export function findImageLikeString(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    if (/^(https?:|data:image\/|blob:|file:)/i.test(text)) return text
    if (/\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(text)) return text
    try {
      return findImageLikeString(JSON.parse(text))
    } catch {
      return ''
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findImageLikeString(item)
      if (result) return result
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['url', 'src', 'href', 'download_url', 'thumbnail', 'thumb']) {
      const result = findImageLikeString(record[key])
      if (result) return result
    }
  }
  return ''
}

export function attachmentNameFromURL(url: string) {
  try {
    const parsed = new URL(url, 'http://kition.local')
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return name || 'attachment'
  } catch {
    const name = decodeURIComponent(url.split(/[/?#]/)[0]?.split('/').filter(Boolean).pop() || '')
    return name || 'attachment'
  }
}

export function parseUrlValue(value: unknown): { href: string; label: string } | null {
  const text =
    typeof value === 'string'
      ? value.trim()
      : displayValue(value as DataRecordValue).trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    return { href: text, label: text }
  }
  if (/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(text)) {
    return { href: `https://${text}`, label: text }
  }
  return null
}

export function normalizeAttachmentValue(value: unknown): DataAttachment[] {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value)) return value.flatMap((item) => normalizeAttachmentValue(item))
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    try {
      return normalizeAttachmentValue(JSON.parse(text))
    } catch {
      return [{ name: attachmentNameFromURL(text), url: text }]
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const url = findImageLikeString(record) || String(record.url || record.src || record.href || '').trim()
    if (!url) return []
    const mimeType =
      typeof record.mimeType === 'string'
        ? record.mimeType
        : typeof record.type === 'string'
          ? record.type
          : undefined
    const sizeBytes =
      typeof record.sizeBytes === 'number'
        ? record.sizeBytes
        : typeof record.size === 'number'
          ? record.size
          : undefined
    return [{
      name: String(record.name || record.filename || record.file_name || attachmentNameFromURL(url)),
      url,
      mimeType,
      sizeBytes,
    }]
  }
  return []
}

export function extractClipboardFiles(clipboardData: DataTransfer | null) {
  const files: File[] = []
  if (!clipboardData) return files
  Array.from(clipboardData.items || []).forEach((item) => {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  })
  Array.from(clipboardData.files || []).forEach((file) => {
    if (!files.some((item) => item.name === file.name && item.size === file.size && item.type === file.type)) files.push(file)
  })
  return files
}

export function coerceValue(field: DataField, raw: DataRecordValue): DataRecordValue {
  if (field.type === 'checkbox') return Boolean(raw)
  if (field.type === 'attachment') return normalizeAttachmentValue(raw)
  if (field.type === 'number') {
    if (typeof raw !== 'string' || !raw.trim()) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  if (field.type === 'multi_select') {
    return typeof raw === 'string' ? raw.split(',').map((item) => item.trim()).filter(Boolean) : []
  }
  return typeof raw === 'boolean' ? String(raw) : raw
}

export function emptyRecordValues(fields: DataField[]) {
  const primaryField = fields.find((field) => field.is_primary) || fields[0]
  return primaryField ? { [primaryField.name]: 'New page' } : {}
}

export function getFieldIcon(field: DataField) {
  if (field.type === 'number' || field.type === 'auto_number') return <Hash className="size-4" />
  if (field.type === 'date' || field.type === 'datetime' || field.type === 'created_time' || field.type === 'last_modified_time') return <CalendarDays className="size-4" />
  if (field.type === 'url' || field.type === 'document_link' || field.type === 'link_to_record') return <Link2 className="size-4" />
  if (field.type === 'checkbox') return <Check className="size-4" />
  if (field.type === 'long_text') return <FileText className="size-4" />
  if (field.type === 'rating') return <Star className="size-4" />
  if (field.type === 'user' || field.type === 'created_by' || field.type === 'last_modified_by') return <User className="size-4" />
  if (field.type === 'button') return <CircleDot className="size-4" />
  if (field.type === 'lookup' || field.type === 'rollup') return <Workflow className="size-4" />
  return <span className="data-inline-field-type-aa">Aa</span>
}

export function getSortDirectionLabels(
  fieldType: DataFieldType,
): { asc: string; desc: string } {
  switch (fieldType) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'single_select':
      return { asc: 'A → Z', desc: 'Z → A' }
    case 'number':
    case 'rating':
    case 'auto_number':
      return { asc: '1 → 9', desc: '9 → 1' }
    case 'date':
    case 'datetime':
    case 'created_time':
    case 'last_modified_time':
      return { asc: 'Earliest → Latest', desc: 'Latest → Earliest' }
    case 'checkbox':
      return { asc: 'Unchecked → Checked', desc: 'Checked → Unchecked' }
    default:
      return { asc: 'Ascending', desc: 'Descending' }
  }
}

export function getSortDirectionLabelKeys(
  fieldType: DataFieldType,
): { asc: string; desc: string } {
  switch (fieldType) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'single_select':
      return { asc: 'sortDirection.textAsc', desc: 'sortDirection.textDesc' }
    case 'number':
    case 'rating':
    case 'auto_number':
      return { asc: 'sortDirection.numberAsc', desc: 'sortDirection.numberDesc' }
    case 'date':
    case 'datetime':
    case 'created_time':
    case 'last_modified_time':
      return { asc: 'sortDirection.dateAsc', desc: 'sortDirection.dateDesc' }
    case 'checkbox':
      return { asc: 'sortDirection.checkboxAsc', desc: 'sortDirection.checkboxDesc' }
    default:
      return { asc: 'sortDirection.ascending', desc: 'sortDirection.descending' }
  }
}

export function getFieldTypeLabel(type: DataFieldType) {
  return fieldTypes.find((item) => item.value === type)?.label || type
}

export async function resolveAIConfigRuntimeModel(
  config: AnyAIConfig,
): Promise<RuntimeWritingModel | undefined> {
  const modelKey = config.runtime_model
  const match = modelKey?.match(/^desktop:([^:]+):(.+)$/)
  if (modelKey && !match) return undefined
  const settings = await loadDesktopSettings()
  if (match) {
    return buildAIFieldDesktopRuntimeModel(
      settings.providers[match[1] as DesktopProviderKind],
      match[1] as DesktopProviderKind,
      match[2],
    )
  }
  const providerKind = settings.models.activeProvider
  const provider = settings.providers[providerKind]
  const modelName = settings.models.selectedModelByProvider[providerKind]
    || settings.models.preferredWritingModel
    || settings.models.preferredChatModel
    || settings.models.preferredDefaultModel
    || provider?.discoveredModels?.[0]
    || ''
  return buildAIFieldDesktopRuntimeModel(provider, providerKind, modelName)
}

function buildAIFieldDesktopRuntimeModel(
  provider: Awaited<ReturnType<typeof loadDesktopSettings>>['providers'][DesktopProviderKind] | undefined,
  providerKind: DesktopProviderKind,
  modelName: string,
): RuntimeWritingModel | undefined {
  const token = provider?.apiKey || provider?.accessToken
  if (!provider?.enabled || !provider.baseUrl || !token || !modelName) {
    return undefined
  }
  return {
    provider_type: providerKind,
    provider_label: provider.label || providerKind,
    model_name: modelName,
    base_url: provider.baseUrl,
    api_key: provider.apiKey,
    access_token: provider.accessToken || undefined,
    auth_header: provider.authHeader || undefined,
    auth_scheme: provider.authScheme,
    wire_api: provider.wireApi,
    reasoning_effort: provider.reasoningEffort,
    hosted_web_search_version: provider.hostedWebSearchVersion,
    disable_response_storage: provider.disableResponseStorage,
  }
}

export function getSelectTone(value: string) {
  // Agent-generated choices are typed string[] but can arrive as numbers; coerce
  // so the char iteration below never throws "value is not iterable".
  let hash = 0
  for (const char of String(value ?? '')) {
    hash = (hash + char.charCodeAt(0)) % selectPalette.length
  }
  return selectPalette[hash]
}

export function normalizeChoiceList(field: DataField): string[] {
  const raw = field.options?.choices
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const choice of raw) {
    // Choices are typed string[] but agent-generated data can arrive as numbers
    // or objects like {name}; displayValue collapses each to a renderable string.
    const label = displayValue(choice as DataRecordValue).trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result
}

export function getChoiceToneMap(field: DataField) {
  const raw = field.options?.choice_tones
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, string>
}

export function normalizeChoiceTone(tone: string) {
  return selectPalette.some((item) => item === tone) ? tone : ''
}

export function getSelectChoiceTone(field: DataField, value: string) {
  return normalizeChoiceTone(getChoiceToneMap(field)[value] || '') || getSelectTone(value)
}

export function getFieldTone(field: DataField) {
  const optionTone = typeof field.options?.column_tone === 'string' ? field.options.column_tone : ''
  if (fieldColorTones.some((item) => item.value === optionTone)) return optionTone
  return fieldToneByType[field.type] || 'slate'
}

export function parsePastedTable(text: string) {
  const normalizedText = text.replace(/\r/g, '').replace(/\n$/, '')
  const delimiter = normalizedText.includes('\t') ? '\t' : ','
  if (delimiter === ',') {
    return normalizedText
      .split('\n')
      .filter((row) => row.length > 0)
      .map(parseCSVLine)
  }
  return normalizedText
    .replace(/\r/g, '')
    .split('\n')
    .filter((row) => row.length > 0)
    .map((row) => row.split('\t').map((cell) => cell.trim()))
}

function parseCSVLine(row: string) {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]
    if (char === '"' && row[index + 1] === '"') {
      cell += '"'
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

export function reorderById<T extends { id: number }>(items: T[], sourceId: number, targetId: number) {
  const sourceIndex = items.findIndex((item) => item.id === sourceId)
  const targetIndex = items.findIndex((item) => item.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items
  const nextItems = [...items]
  const [moved] = nextItems.splice(sourceIndex, 1)
  nextItems.splice(targetIndex, 0, moved)
  return nextItems
}

export function reorderByIdAtPosition<T extends { id: number }>(items: T[], sourceId: number, targetId: number, position: RowDropPosition) {
  if (sourceId === targetId) return items
  const nextItems = [...items]
  const sourceIndex = nextItems.findIndex((item) => item.id === sourceId)
  if (sourceIndex < 0) return items
  const [moved] = nextItems.splice(sourceIndex, 1)
  const targetIndex = nextItems.findIndex((item) => item.id === targetId)
  if (targetIndex < 0) return items
  nextItems.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, moved)
  return nextItems
}

export function compareRecordValues(a: DataRecordValue, b: DataRecordValue, direction: SortDirection) {
  const left = displayValue(a)
  const right = displayValue(b)
  const result = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  return direction === 'asc' ? result : -result
}

export function readViewConfig(view?: DataView | null): DataInlineViewConfig {
  return (view?.config || {}) as DataInlineViewConfig
}

export function kanbanGroupToValue(field: DataField, group: string): string | boolean {
  if (field.type === 'checkbox') return group === 'true'
  if (group === 'Empty') return ''
  return group
}

export function recordMatchesSearch(record: DataRecord, fields: DataField[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return fields.some((field) => displayValue(record.values?.[field.name] ?? null).toLowerCase().includes(normalized))
}

export type FieldSaveUpdates = {
  title?: string
  type?: DataFieldType
  required?: boolean
  readonly?: boolean
  options?: DataFieldOptions | null
  formula?: string
}

export function buildGroupId(values: ReadonlyArray<unknown>): string {
  return values
    .map((value, depth) => `g${depth}:${JSON.stringify(value ?? null)}`)
    .join('::')
}

function groupValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export function buildGroupPoints(
  records: DataRecord[],
  groupItems: DataInlineGroupItem[],
  collapsedIds: ReadonlySet<string>,
): IGroupPoint[] {
  if (!records.length || !groupItems.length) return []
  const points: IGroupPoint[] = []
  let prevKeys: unknown[] | null = null
  let rowRunCount = 0

  const flushRowRun = () => {
    if (rowRunCount > 0) {
      points.push({ type: LinearRowType.Row, count: rowRunCount })
      rowRunCount = 0
    }
  }

  for (const record of records) {
    const keys = groupItems.map((item) => record.values?.[item.field_name] ?? null)

    let changedDepth = -1
    if (prevKeys === null) {
      changedDepth = 0
    } else {
      for (let d = 0; d < keys.length; d++) {
        if (!groupValuesEqual(keys[d], prevKeys[d])) {
          changedDepth = d
          break
        }
      }
    }

    if (changedDepth !== -1) {
      flushRowRun()
      for (let d = changedDepth; d < keys.length; d++) {
        const id = buildGroupId(keys.slice(0, d + 1))
        points.push({
          id,
          type: LinearRowType.Group,
          depth: d,
          value: keys[d],
          isCollapsed: collapsedIds.has(id),
        })
      }
    }
    rowRunCount++
    prevKeys = keys
  }
  flushRowRun()
  return points
}

export function buildGroupCollection(
  groupItems: DataInlineGroupItem[],
  fields: DataField[],
): IGroupCollection {
  const groupColumns: IGridColumn[] = groupItems.map((item, index) => {
    const field = fields.find((candidate) => candidate.name === item.field_name)
    return {
      id: `group:${index}:${item.field_name}`,
      name: field?.title || item.field_name,
    }
  })

  return {
    groupColumns,
    getGroupCell: (cellValue: unknown): ICell => {
      const text = displayValue(cellValue as DataRecordValue).trim() || 'Empty'
      return {
        type: CellType.Text,
        data: text,
        displayData: text,
      }
    },
  }
}
