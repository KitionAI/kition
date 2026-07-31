import type { DataRecordValue, DataViewSeed } from '@/types/dataDocument'

import type {
  KitableTemplateCategory,
  KitableTemplateDefinition,
  KitableTemplateField,
  KitableTemplatePreview,
} from './kitableTemplates'

type OperationalTemplateInput = {
  id: string
  title: string
  description: string
  categories: KitableTemplateCategory[]
  preview: KitableTemplatePreview
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
    preview: input.preview,
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
      categories: ['data-analysis', 'administration'],
      preview: 'task-tracker',
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
      id: 'ecommerce-orders-returns',
      title: 'Ecommerce Orders & Returns',
      description: 'Track orders, fulfillment, returns, refunds, and after-sales issues.',
      categories: ['commerce', 'popular'],
      preview: 'crm',
      icon: 'shopping-bag',
      color: 'amber',
      tableTitle: 'Orders',
      fields: [
        { title: 'Order', type: 'text', primary: true },
        { title: 'Customer', type: 'text' },
        { title: 'Channel', type: 'single_select', options: { choices: ['Marketplace', 'Retail', 'Social', 'Website'] } },
        { title: 'Amount', type: 'number' },
        { title: 'Order status', type: 'single_select', options: { choices: ['New', 'Packed', 'Shipped', 'Delivered', 'Returned'] } },
        { title: 'After-sales status', type: 'single_select', options: { choices: ['None', 'Requested', 'Approved', 'Refunded'] } },
        { title: 'Order date', type: 'date' },
      ],
      views: [gridView, { title: 'Fulfillment board', type: 'kanban' }],
      records: [
        { Order: 'ORD-20481', Customer: 'Customer 1', Channel: 'Website', Amount: 142, 'Order status': 'Delivered', 'After-sales status': 'None', 'Order date': '2026-07-24' },
        { Order: 'ORD-20482', Customer: 'Customer 2', Channel: 'Marketplace', Amount: 86, 'Order status': 'Returned', 'After-sales status': 'Requested', 'Order date': '2026-07-25' },
        { Order: 'ORD-20483', Customer: 'Customer 3', Channel: 'Social', Amount: 219, 'Order status': 'Shipped', 'After-sales status': 'None', 'Order date': '2026-07-27' },
      ],
    }),
    operationalTemplate({
      id: 'recruitment-pipeline',
      title: 'Recruitment Pipeline',
      description: 'Track hiring demand, candidates, interviews, decisions, and offers.',
      categories: ['human-resources', 'popular'],
      preview: 'crm',
      icon: 'user-round-search',
      color: 'rose',
      tableTitle: 'Candidates',
      fields: [
        { title: 'Candidate', type: 'text', primary: true },
        { title: 'Role', type: 'text' },
        { title: 'Stage', type: 'single_select', options: { choices: ['Applied', 'Screen', 'Interview', 'Offer', 'Hired', 'Rejected'] } },
        { title: 'Recruiter', type: 'text' },
        { title: 'Hiring manager', type: 'text' },
        { title: 'Interview date', type: 'datetime' },
        { title: 'Score', type: 'rating', options: { max: 5 } },
        { title: 'Notes', type: 'long_text' },
      ],
      views: [gridView, { title: 'Hiring pipeline', type: 'kanban' }],
      records: [
        { Candidate: 'Alex Morgan', Role: 'Product Designer', Stage: 'Interview', Recruiter: 'Nina Cole', 'Hiring manager': 'Maya Chen', 'Interview date': '2026-07-30T08:00:00Z', Score: 4, Notes: 'Strong portfolio and clear systems thinking.' },
        { Candidate: 'Jamie Park', Role: 'Frontend Engineer', Stage: 'Screen', Recruiter: 'Nina Cole', 'Hiring manager': 'Eli Brooks', Score: 4 },
        { Candidate: 'Taylor Reed', Role: 'Account Executive', Stage: 'Offer', Recruiter: 'Omar Lewis', 'Hiring manager': 'Robin Fox', Score: 5, Notes: 'References completed.' },
      ],
    }),
    operationalTemplate({
      id: 'project-gantt',
      title: 'Project Gantt Planner',
      description: 'Plan project tasks, dependencies, ownership, and delivery dates.',
      categories: ['project-management', 'collaboration'],
      preview: 'task-tracker',
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
