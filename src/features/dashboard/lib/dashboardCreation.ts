import type {
  DashboardLayoutItem,
  DataDashboard,
  DataDashboardWidget,
  DataField,
  DataTable,
} from '@/types/dataDocument'

export function createStarterDataDashboard(
  table: DataTable,
  existingDashboards: DataDashboard[],
): DataDashboard {
  const sourceTitle = table.title.trim() || 'Data'
  const title = createUniqueTitle(`${sourceTitle} Dashboard`, existingDashboards)
  const id = createUniqueId(slugify(title) || 'dashboard', existingDashboards)
  const fields = [...(table.fields || [])].sort((left, right) => left.order - right.order)
  const checkboxField = fields.find((field) => field.type === 'checkbox')
  const selectField = fields.find((field) => field.type === 'single_select')
  const dateField = fields.find((field) => (
    field.type === 'date'
    || field.type === 'datetime'
    || field.type === 'created_time'
    || field.type === 'last_modified_time'
  ))
  const widgets: DataDashboardWidget[] = []
  const layout: DashboardLayoutItem[] = []

  addWidget(widgets, layout, {
    widget: {
      id: 'total-records',
      title: 'Total records',
      description: `All records in ${sourceTitle}`,
      type: 'metric',
      query: { aggregation: 'count' },
      config: { value_label: 'records' },
    },
    layout: { x: 0, y: 0, w: 3, h: 2, min_w: 2, min_h: 2 },
  })

  if (checkboxField) {
    addWidget(widgets, layout, {
      widget: {
        id: `checked-${slugify(checkboxField.name) || 'field'}`,
        title: checkboxField.title,
        description: `Records where ${checkboxField.title} is checked`,
        type: 'metric',
        query: { aggregation: 'count_true', field_name: checkboxField.name },
        config: { value_label: 'records' },
      },
      layout: { x: 3, y: 0, w: 3, h: 2, min_w: 2, min_h: 2 },
    })
  }

  if (selectField) {
    addWidget(widgets, layout, {
      widget: {
        id: `${slugify(selectField.name) || 'field'}-distribution`,
        title: `${selectField.title} distribution`,
        description: `Record count by ${selectField.title}`,
        type: 'pie',
        query: { aggregation: 'count', group_by_field_name: selectField.name },
        config: {
          category_order: Array.isArray(selectField.options?.choices)
            ? selectField.options.choices
            : undefined,
        },
      },
      layout: { x: 0, y: 2, w: 6, h: 4, min_w: 4, min_h: 3 },
    })
  }

  if (dateField) {
    addWidget(widgets, layout, {
      widget: {
        id: `${slugify(dateField.name) || 'field'}-timeline`,
        title: `${dateField.title} timeline`,
        description: `Record count by ${dateField.title}`,
        type: 'line',
        query: { aggregation: 'count', group_by_field_name: dateField.name },
      },
      layout: {
        x: selectField ? 6 : 0,
        y: 2,
        w: 6,
        h: 4,
        min_w: 4,
        min_h: 3,
      },
    })
  }

  const columns = fields.slice(0, 5).map((field) => field.name)
  addWidget(widgets, layout, {
    widget: {
      id: 'records',
      title: 'Records',
      description: `Live records from ${sourceTitle}`,
      type: 'table',
      query: { aggregation: 'count', columns, limit: 10 },
    },
    layout: {
      x: 0,
      y: selectField || dateField ? 6 : 2,
      w: 12,
      h: 5,
      min_w: 5,
      min_h: 4,
    },
  })

  return {
    id,
    title,
    order: existingDashboards.reduce((maximum, dashboard) => (
      Math.max(maximum, dashboard.order)
    ), -1) + 1,
    source_table_id: table.id,
    layout,
    widgets,
  }
}

function addWidget(
  widgets: DataDashboardWidget[],
  layout: DashboardLayoutItem[],
  item: {
    widget: DataDashboardWidget
    layout: Omit<DashboardLayoutItem, 'widget_id'>
  },
) {
  widgets.push(item.widget)
  layout.push({ widget_id: item.widget.id, ...item.layout })
}

function createUniqueTitle(baseTitle: string, dashboards: DataDashboard[]) {
  const existingTitles = new Set(dashboards.map((dashboard) => dashboard.title.toLowerCase()))
  if (!existingTitles.has(baseTitle.toLowerCase())) return baseTitle
  let suffix = 2
  while (existingTitles.has(`${baseTitle} ${suffix}`.toLowerCase())) suffix += 1
  return `${baseTitle} ${suffix}`
}

function createUniqueId(baseId: string, dashboards: DataDashboard[]) {
  const existingIds = new Set(dashboards.map((dashboard) => dashboard.id))
  if (!existingIds.has(baseId)) return baseId
  let suffix = 2
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
