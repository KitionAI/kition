import type {
  DataDashboardWidget,
  DataField,
  DataRecord,
  DataRecordValue,
} from '@/types/dataDocument'

export type DashboardMetricResult = {
  kind: 'metric'
  value: number
}

export type DashboardSeriesPoint = {
  label: string
  value: number
}

export type DashboardSeriesResult = {
  kind: 'series'
  points: DashboardSeriesPoint[]
}

export type DashboardTableResult = {
  kind: 'table'
  columns: Array<{ name: string; title: string }>
  rows: Array<{ id: number; values: Record<string, DataRecordValue> }>
}

export type DashboardQueryResult =
  | DashboardMetricResult
  | DashboardSeriesResult
  | DashboardTableResult

export function executeDashboardWidgetQuery(
  widget: DataDashboardWidget,
  records: DataRecord[],
  fields: DataField[],
): DashboardQueryResult {
  const filtered = records.filter((record) => (
    (widget.query.filters || []).every((filter) => {
      const value = record.values?.[filter.field_name] ?? null
      switch (filter.operator) {
        case 'equals':
          return valuesEqual(value, filter.value ?? null)
        case 'not_equals':
          return !valuesEqual(value, filter.value ?? null)
        case 'truthy':
          return isTruthyValue(value)
        case 'falsy':
          return !isTruthyValue(value)
        default:
          return true
      }
    })
  ))

  if (widget.type === 'table') {
    const requestedColumns = new Set(widget.query.columns || [])
    const columns = fields
      .filter((field) => requestedColumns.has(field.name))
      .map((field) => ({ name: field.name, title: field.title }))
    return {
      kind: 'table',
      columns,
      rows: filtered.slice(0, widget.query.limit || 10).map((record) => ({
        id: record.id,
        values: record.values,
      })),
    }
  }

  const groupFieldName = widget.query.group_by_field_name
  if (groupFieldName) {
    const counts = new Map<string, number>()
    filtered.forEach((record) => {
      const label = displayGroupValue(record.values?.[groupFieldName] ?? null)
      const increment = widget.query.aggregation === 'count_true'
        ? Number(isTruthyValue(record.values?.[widget.query.field_name || ''] ?? null))
        : 1
      counts.set(label, (counts.get(label) || 0) + increment)
    })
    const categoryOrder = widget.config?.category_order || []
    const categoryIndex = new Map(categoryOrder.map((label, index) => [label, index]))
    const points = Array.from(counts, ([label, value]) => ({ label, value }))
      .sort((left, right) => {
        const leftIndex = categoryIndex.get(left.label)
        const rightIndex = categoryIndex.get(right.label)
        if (leftIndex != null || rightIndex != null) {
          return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER)
        }
        if (widget.type === 'line') {
          return left.label.localeCompare(right.label, undefined, { numeric: true })
        }
        return right.value - left.value || left.label.localeCompare(right.label)
      })
    return { kind: 'series', points }
  }

  return {
    kind: 'metric',
    value: widget.query.aggregation === 'count_true'
      ? filtered.filter((record) => (
        isTruthyValue(record.values?.[widget.query.field_name || ''] ?? null)
      )).length
      : filtered.length,
  }
}

function valuesEqual(left: DataRecordValue, right: DataRecordValue) {
  if (left === right) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

function isTruthyValue(value: DataRecordValue) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return true
  return Boolean(value)
}

function displayGroupValue(value: DataRecordValue) {
  if (value == null || value === '') return 'Empty'
  if (Array.isArray(value)) return value.join(', ') || 'Empty'
  if (typeof value === 'object') return 'Attachment'
  return String(value)
}
