import type { DataRecordValue, DataViewSeed } from '@/types/dataDocument'

import type {
  KitableTemplateCategory,
  KitableTemplateDefinition,
  KitableTemplateField,
} from './kitableTemplates'

type OperationalTemplateInput = {
  id: string
  title: string
  description: string
  categories: KitableTemplateCategory[]
  icon: string
  color: string
  tableTitle: string
  fields: KitableTemplateField[]
  records: Array<Record<string, DataRecordValue>>
  views?: DataViewSeed[]
}

const gridView: DataViewSeed = { title: 'Grid', type: 'grid' }

function operationalTemplate(input: OperationalTemplateInput): KitableTemplateDefinition {
  const resourceId = `${input.id}-table`
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    documentDescription: input.description,
    usageCount: 320 + input.records.length * 137,
    coverImage: `kition-bundled:/templates/table-covers/${input.id}.webp`,
    icon: input.icon,
    color: input.color,
    categories: input.categories,
    snapshot: {
      version: 1,
      includeData: true,
      defaultResourceId: resourceId,
      resources: [{
        id: resourceId,
        kind: 'table',
        title: input.tableTitle,
        description: input.description,
        tableTitle: input.tableTitle,
      }],
    },
    tables: [{
      title: input.tableTitle,
      description: input.description,
      fields: input.fields,
      views: input.views || [gridView],
      records: input.records,
    }],
  }
}

export function getOperationalKitableTemplates(): KitableTemplateDefinition[] {
  return [
    operationalTemplate({
      id: 'business-analytics-dashboard',
      title: 'Business Analytics Dashboard',
      description: 'Monitor revenue, cost, margin, and collection performance by period.',
      categories: ['business'],
      icon: 'chart-no-axes-combined',
      color: 'sky',
      tableTitle: 'Business Metrics',
      fields: [
        { title: 'Period', type: 'text', primary: true },
        { title: 'Revenue', type: 'number' },
        { title: 'Cost', type: 'number' },
        { title: 'Gross margin', type: 'number' },
        { title: 'Cash collected', type: 'number' },
        { title: 'Open receivables', type: 'number' },
        { title: 'Owner', type: 'text' },
      ],
      records: [
        { Period: '2026 Q1', Revenue: 480000, Cost: 292000, 'Gross margin': 39.2, 'Cash collected': 451000, 'Open receivables': 29000, Owner: 'Finance' },
        { Period: '2026 Q2', Revenue: 552000, Cost: 318000, 'Gross margin': 42.4, 'Cash collected': 519000, 'Open receivables': 33000, Owner: 'Finance' },
        { Period: '2026 Q3 Forecast', Revenue: 621000, Cost: 354000, 'Gross margin': 43.0, 'Cash collected': 570000, 'Open receivables': 51000, Owner: 'Operations' },
      ],
    }),
    operationalTemplate({
      id: 'project-gantt',
      title: 'Project Gantt Planner',
      description: 'Plan project tasks, dependencies, ownership, and delivery dates.',
      categories: ['projects'],
      icon: 'gantt-chart',
      color: 'violet',
      tableTitle: 'Project Plan',
      fields: [
        { title: 'Task', type: 'text', primary: true },
        { title: 'Workstream', type: 'single_select', options: { choices: ['Design', 'Engineering', 'Launch', 'Research'] } },
        { title: 'Owner', type: 'text' },
        { title: 'Start date', type: 'date' },
        { title: 'End date', type: 'date' },
        { title: 'Progress', type: 'number' },
        { title: 'Status', type: 'single_select', options: { choices: ['Not started', 'In progress', 'Blocked', 'Done'] } },
        { title: 'Dependency', type: 'text' },
      ],
      views: [gridView, { title: 'Timeline', type: 'calendar' }, { title: 'Status board', type: 'kanban' }],
      records: [
        { Task: 'Customer research synthesis', Workstream: 'Research', Owner: 'Maya Chen', 'Start date': '2026-07-20', 'End date': '2026-07-29', Progress: 90, Status: 'In progress' },
        { Task: 'Interaction design', Workstream: 'Design', Owner: 'Sofia Rivera', 'Start date': '2026-07-27', 'End date': '2026-08-07', Progress: 35, Status: 'In progress', Dependency: 'Customer research synthesis' },
        { Task: 'Frontend implementation', Workstream: 'Engineering', Owner: 'Eli Brooks', 'Start date': '2026-08-03', 'End date': '2026-08-17', Progress: 0, Status: 'Not started', Dependency: 'Interaction design' },
      ],
    }),
  ]
}
