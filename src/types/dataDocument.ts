import type { AnyAIConfig } from './aiConfig'
import type { FilterGroup } from '@/features/table/filter'

export type DataFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'single_select'
  | 'multi_select'
  | 'checkbox'
  | 'url'
  | 'attachment'
  | 'document_link'
  | 'formula'
  | 'rating'
  | 'user'
  | 'link_to_record'
  | 'lookup'
  | 'rollup'
  | 'button'
  | 'created_time'
  | 'last_modified_time'
  | 'created_by'
  | 'last_modified_by'
  | 'auto_number'

export type DataViewType = 'grid' | 'form' | 'kanban' | 'calendar' | 'gallery'

export type DataDateFormat =
  | 'year_month_day_slash'
  | 'year_month_day_time_slash'
  | 'year_month_day_time_zone_slash'
  | 'year_month_day_dash'
  | 'year_month_day_time_dash'
  | 'year_month_day_time_zone_dash'
  | 'month_day_dash'
  | 'month_day_year_slash'
  | 'day_month_year_slash'

export type DataFieldOptions = {
  choices?: string[]
  date_format?: DataDateFormat
  [key: string]: unknown
}

export type RatingOptions = {
  max?: number
  icon?: 'star' | 'heart' | 'thumbs'
}

export type LinkOptions = {
  target_table_id: number
  allow_multiple?: boolean
  symmetric_field_id?: number | null
}

export type LookupAggregation = 'list' | 'concat'

export type LookupOptions = {
  link_field_id: number
  target_field_id: number
  multi_value_mode?: LookupAggregation
}

export type RollupAggregation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'max'
  | 'min'
  | 'and'
  | 'or'
  | 'concat'

export type RollupOptions = {
  link_field_id: number
  target_field_id: number
  aggregation: RollupAggregation
}

export type ButtonAction =
  | { kind: 'open_url'; url: string }
  | { kind: 'run_workflow'; workflow_id: number }

export type ButtonOptions = {
  label: string
  action: ButtonAction
}

export type AutoNumberOptions = {
  format?: 'plain' | 'prefixed'
  prefix?: string
  start_at?: number
}

export type UserOptions = {
  allow_multiple?: boolean
}

export type LinkRef = {
  row_key: string
  display: string
}

export type LinkValue = LinkRef[]

export type UserRef = {
  id: string
  name: string
  avatar?: string
}

export type UserValue = UserRef[]

export type DataField = {
  id: number
  user_id: number
  document_id: number
  table_id: number
  name: string
  title: string
  type: DataFieldType
  required: boolean
  unique: boolean
  readonly: boolean
  is_primary: boolean
  order: number
  options?: DataFieldOptions | null
  link_config?: LinkOptions | null
  lookup_config?: LookupOptions | null
  rollup_config?: RollupOptions | null
  formula?: string
  ai_config?: AnyAIConfig | null
  meta?: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type DataView = {
  id: number
  user_id: number
  document_id: number
  table_id: number
  title: string
  type: DataViewType
  order: number
  locked: boolean
  config?: DataViewConfig | null
  created_at: string
  updated_at: string
}

export type DataTable = {
  id: number
  user_id: number
  document_id: number
  name: string
  title: string
  description: string
  order: number
  primary_field_id?: number | null
  meta?: Record<string, unknown> | null
  fields?: DataField[]
  views?: DataView[]
  created_at: string
  updated_at: string
}

export type DashboardWidgetType = 'metric' | 'bar' | 'line' | 'pie' | 'table'

export type DashboardQueryFilter = {
  field_name: string
  operator: 'equals' | 'not_equals' | 'truthy' | 'falsy'
  value?: DataRecordValue
}

export type DashboardQuery = {
  aggregation: 'count' | 'count_true'
  field_name?: string
  group_by_field_name?: string
  filters?: DashboardQueryFilter[]
  columns?: string[]
  limit?: number
}

export type DashboardLayoutItem = {
  widget_id: string
  x: number
  y: number
  w: number
  h: number
  min_w?: number
  min_h?: number
}

export type DataDashboardWidget = {
  id: string
  title: string
  description?: string
  type: DashboardWidgetType
  query: DashboardQuery
  config?: {
    value_label?: string
    color?: string
    category_order?: string[]
  }
}

export type DataDashboard = {
  id: string
  title: string
  order: number
  source_table_id: number
  layout: DashboardLayoutItem[]
  widgets: DataDashboardWidget[]
}

export type DataDashboardSeed = Omit<DataDashboard, 'source_table_id'> & {
  source_table_name: string
}

export type DataDocument = {
  id: number
  user_id: number
  workspace_root: string
  path: string
  title: string
  description: string
  icon: string
  color: string
  meta?: Record<string, unknown> | null
  tables?: DataTable[]
  created_at: string
  updated_at: string
}

export type DataAttachment = {
  name: string
  url: string
  mimeType?: string
  sizeBytes?: number
}

export type DataRecordValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | DataAttachment
  | DataAttachment[]
  | LinkValue
  | UserValue
  | null

export type DataRecord = {
  id: number
  user_id: number
  document_id: number
  table_id: number
  row_key: string
  order: number
  values: Record<string, DataRecordValue>
  auto_number?: number | null
  created_by?: string
  updated_by?: string
  created_at: string
  updated_at: string
}

export type DataListResponse<T> = {
  items: T[]
  total: number
  offset?: number
  limit?: number
}

export type DataFieldSeed = {
  title: string
  name?: string
  type: DataFieldType
  primary?: boolean
  required?: boolean
  readonly?: boolean
  options?: DataFieldOptions | null
  formula?: string
}

export type DataViewSeed = {
  title: string
  type: DataViewType
  config?: Record<string, unknown> | null
}

export type DataTableSeed = {
  title: string
  name?: string
  description?: string
  fields?: DataFieldSeed[]
  views?: DataViewSeed[]
}

export type CreateDataDocumentPayload = {
  title: string
  description?: string
  workspace_root?: string
  path?: string
  icon?: string
  color?: string
  meta?: Record<string, unknown> | null
  tables?: DataTableSeed[]
}

export type CreateDataTablePayload = DataTableSeed

export type CreateDataFieldPayload = {
  title: string
  name?: string
  type: DataFieldType
  required?: boolean
  readonly?: boolean
  is_primary?: boolean
  options?: DataFieldOptions | null
  link_config?: LinkOptions | null
  lookup_config?: LookupOptions | null
  rollup_config?: RollupOptions | null
  formula?: string
  meta?: Record<string, unknown> | null
  order?: number
}

export type RecordHistoryEntry = {
  id: number
  document_id: number
  table_id: number
  record_id: number
  field_id?: number | null
  action: 'create' | 'update' | 'delete' | 'duplicate' | 'link' | 'unlink'
  before?: DataRecordValue | Record<string, DataRecordValue> | null
  after?: DataRecordValue | Record<string, DataRecordValue> | null
  actor?: string
  created_at: string
}

export type RecordHistoryResponse = DataListResponse<RecordHistoryEntry>

export type LinkCandidate = {
  row_key: string
  display: string
}

export type LinkCandidatesResponse = {
  items: LinkCandidate[]
}

export type UpsertRecordLinksPayload = {
  field_id: number
  target_row_keys: string[]
}

export type CreateDataViewPayload = {
  title: string
  type: DataViewType
  config?: Record<string, unknown> | null
}

export type InferDataDocumentSchemaResponse = {
  title: string
  tables: DataTableSeed[]
}

export type SortDirection = 'asc' | 'desc'

export type SortItem = {
  field_id: number
  direction: SortDirection
}

export type GroupItem = {
  field_id: number
  direction: SortDirection
}

export type RowHeight = 'short' | 'medium' | 'tall' | 'extra_tall'

export type ViewFieldLayout = {
  view_id: number
  field_id: number
  visible: boolean
  width: number
  position: number
  frozen: boolean
}

export type DataViewConfig = {
  filter_tree?: FilterGroup | null
  sorts?: SortItem[]
  groups?: GroupItem[]
  row_height?: RowHeight
  frozen_column_count?: number
  search_query?: string
  hidden_field_names?: string[]
  cover_field_name?: string
  group_field_name?: string
  [key: string]: unknown
}

export type ViewSortsResponse = {
  items: SortItem[]
}

export type ViewGroupsResponse = {
  items: GroupItem[]
}

export type ViewFieldsResponse = {
  items: ViewFieldLayout[]
}

export type ViewFieldPatchPayload = {
  visible?: boolean
  width?: number
  position?: number
  frozen?: boolean
}

export type ViewConfigPatchPayload = {
  row_height?: RowHeight | null
  frozen_column_count?: number
  search_query?: string | null
}

export type BulkDeleteRecordsPayload = {
  row_keys: string[]
}

export type BulkCopyRecordsPayload = {
  row_keys: string[]
  target_position?: number
}

export type BulkDeleteRecordsResult = {
  deleted_count: number
  missing_keys: string[]
}

export type BulkCopyRecordsResult = {
  copied_count: number
  new_row_keys: string[]
}
