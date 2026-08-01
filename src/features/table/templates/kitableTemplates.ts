import type { TFunction } from 'i18next'

import type {
  DataDashboardSeed,
  DataFieldSeed,
  DataRecordValue,
  DataViewSeed,
} from '@/types/dataDocument'
import type { AnyAIConfig } from '@/types/aiConfig'
import type { FormSyncTemplateSetup } from '@/features/formSync/templateSetup'
import { createBatchProductDesignerTemplate } from './batchProductDesignerTemplate'
import { getOperationalKitableTemplates } from './kitableOperationalTemplates'
import { createReceiptOcrTemplate } from './receiptOcrTemplate'
import { createTaskTrackerTemplate } from './taskTrackerTemplate'
import { createThumbnailGeneratorTemplate } from './thumbnailGeneratorTemplate'
import { EMAIL_INBOX_SYNC_TEMPLATE_ID } from '@/features/emailSync/templateSetup'

export type KitableTemplateCategory =
  | 'recommended'
  | 'ai-workflows'
  | 'business'
  | 'projects'

type KitableTemplateAIConfigFor<Config extends AnyAIConfig> =
  Config extends { source_field_id: number }
    ? Omit<Config, 'source_field_id'> & { sourceFieldTitle: string }
    : Omit<Config, 'source_field_id'> & { sourceFieldTitle?: string }

export type KitableTemplateAIFieldConfig = AnyAIConfig extends infer Config
  ? Config extends AnyAIConfig
    ? KitableTemplateAIConfigFor<Config>
    : never
  : never

export type KitableTemplateField = DataFieldSeed & {
  aiConfig?: KitableTemplateAIFieldConfig
}

export type KitableTemplateAssetReference = {
  assetIds: string[]
}

export type KitableTemplateRecordValue = DataRecordValue | KitableTemplateAssetReference

export type KitableTemplateViewFieldLayout = {
  fieldTitle: string
  visible?: boolean
  width?: number
  position?: number
  frozen?: boolean
}

export type KitableTemplateView = DataViewSeed & {
  hiddenFieldTitles?: string[]
  fieldLayouts?: KitableTemplateViewFieldLayout[]
}

export type KitableTemplateTable = {
  title: string
  description: string
  fields: KitableTemplateField[]
  views: KitableTemplateView[]
  records: Array<Record<string, KitableTemplateRecordValue>>
}

export type KitableTemplateResourceKind = 'app' | 'automation' | 'dashboard' | 'table'

export type KitableTemplateResource = {
  id: string
  kind: KitableTemplateResourceKind
  title: string
  description: string
  tableTitle?: string
}

export type KitableTemplateSnapshot = {
  version: number
  includeData: boolean
  defaultResourceId: string
  resources: KitableTemplateResource[]
}

export type KitableTemplateDefinition = {
  id: string
  title: string
  description: string
  documentDescription: string
  usageCount: number
  coverImage: string
  icon: string
  color: string
  categories?: KitableTemplateCategory[]
  snapshot: KitableTemplateSnapshot
  tables: KitableTemplateTable[]
  dashboards?: DataDashboardSeed[]
  assetManifestPath?: string
  localOnly?: boolean
  afterCreate?:
    | {
        type: 'email-sync'
        runAfterSave: 'full'
      }
    | FormSyncTemplateSetup
}

const gridView: DataViewSeed = { title: 'Grid', type: 'grid' }

export type KitableTemplateSeed = Omit<KitableTemplateDefinition, 'coverImage' | 'snapshot'>

const solutionResources: Record<string, Omit<KitableTemplateSnapshot, 'version' | 'includeData'>> = {
  'task-tracker': {
    defaultResourceId: 'task-management',
    resources: [
      { id: 'task-management', kind: 'table', title: 'Task Management', description: 'Grouped task planning and progress tracking.', tableTitle: 'Task Management' },
      { id: 'task-dashboard', kind: 'dashboard', title: 'Task Dashboard', description: 'Live task progress, workload, and priority reporting.' },
    ],
  },
  'thumbnail-generator': {
    defaultResourceId: 'thumbnail-workbench',
    resources: [
      { id: 'thumbnail-workbench', kind: 'table', title: 'Video Thumbnails Generator', description: 'Structured creative inputs and generated 16:9 and 9:16 outputs.', tableTitle: 'Video Thumbnails Generator' },
    ],
  },
  'receipt-ocr-database': {
    defaultResourceId: 'receipt-database',
    resources: [
      { id: 'receipt-database', kind: 'table', title: 'Receipts', description: 'Receipt images with searchable fields, structured JSON, and plain OCR text.', tableTitle: 'Receipts' },
    ],
  },
  'leads-landing-page': {
    defaultResourceId: 'leads-page',
    resources: [
      { id: 'leads-page', kind: 'app', title: 'Leads Landing Page', description: 'Public lead-capture experience backed by the Leads table.' },
      { id: 'leads', kind: 'table', title: 'Leads', description: 'Form submissions, qualification details, and follow-up state.', tableTitle: 'Leads' },
      { id: 'lead-routing', kind: 'automation', title: 'Lead routing', description: 'Routes new submissions into the follow-up workflow.' },
    ],
  },
  'sdr-cold-call-manager': {
    defaultResourceId: 'cold-calling-app',
    resources: [
      { id: 'cold-calling-app', kind: 'app', title: 'Cold Calling App', description: 'Access-key-gated calling queue for sales representatives.' },
      { id: 'call-queue', kind: 'table', title: 'Call Queue', description: 'Assigned leads, call priority, attempts, and next actions.', tableTitle: 'Call Queue' },
      { id: 'call-logging', kind: 'automation', title: 'Call logging', description: 'Captures call outcomes and schedules the next action.' },
    ],
  },
  'product-launch-website': {
    defaultResourceId: 'launch-site',
    resources: [
      { id: 'launch-site', kind: 'app', title: 'Product Launch Website', description: 'Published product experience driven by structured content.' },
      { id: 'website-sections', kind: 'table', title: 'Website Sections', description: 'Content, asset, owner, and readiness source of truth.', tableTitle: 'Website Sections' },
      { id: 'publish-workflow', kind: 'automation', title: 'Publish workflow', description: 'Moves approved content into the published experience.' },
    ],
  },
  'batch-product-designer': {
    defaultResourceId: 'product-concepts',
    resources: [
      { id: 'product-concepts', kind: 'table', title: 'Product Concepts', description: 'Briefs, generated product imagery, and social copy.', tableTitle: 'Product Concepts' },
    ],
  },
  'simple-client-crm': {
    defaultResourceId: 'clients',
    resources: [
      { id: 'clients', kind: 'table', title: 'Clients', description: 'Prospects and customers moving through the sales pipeline.', tableTitle: 'Clients' },
      { id: 'quotes', kind: 'table', title: 'Quotes', description: 'Commercial proposals and approval progress.', tableTitle: 'Quotes' },
      { id: 'contact-form', kind: 'app', title: 'Get in touch', description: 'Public contact form that creates CRM records.' },
      { id: 'quote-follow-up', kind: 'automation', title: 'Quote follow-up', description: 'Keeps commercial follow-up connected to client activity.' },
    ],
  },
  'lumiere-restaurant': {
    defaultResourceId: 'restaurant-site',
    resources: [
      { id: 'restaurant-site', kind: 'app', title: 'Restaurant Website', description: 'Guest-facing dining and private-event experience.' },
      { id: 'reservations', kind: 'table', title: 'Reservations', description: 'Service schedule, guest preferences, and dining status.', tableTitle: 'Reservations' },
      { id: 'private-events', kind: 'table', title: 'Private Events', description: 'Private dining inquiries and delivery details.', tableTitle: 'Private Events' },
      { id: 'private-event-intake', kind: 'automation', title: 'Private event intake', description: 'Pulls public event inquiries from Kition Cloud into the Private Events table.' },
    ],
  },
  [EMAIL_INBOX_SYNC_TEMPLATE_ID]: {
    defaultResourceId: 'inbox',
    resources: [
      { id: 'inbox', kind: 'table', title: 'Inbox', description: 'Mailbox messages, metadata, and local Markdown links.', tableTitle: 'Inbox' },
      { id: 'full-inbox-sync', kind: 'automation', title: 'Full inbox sync', description: 'Imports the selected mailbox history first, then keeps later runs incremental.' },
    ],
  },
}

const solutionCategories: Record<string, KitableTemplateCategory[]> = {
  'task-tracker': ['recommended', 'projects'],
  'thumbnail-generator': ['recommended', 'ai-workflows'],
  'receipt-ocr-database': ['recommended', 'ai-workflows'],
  'leads-landing-page': ['recommended', 'business'],
  'sdr-cold-call-manager': ['ai-workflows', 'business'],
  'product-launch-website': ['recommended', 'business', 'projects'],
  'batch-product-designer': ['ai-workflows', 'business'],
  'simple-client-crm': ['recommended', 'business'],
  'lumiere-restaurant': ['business'],
  [EMAIL_INBOX_SYNC_TEMPLATE_ID]: ['recommended', 'ai-workflows'],
}

export function getBuiltinKitableTemplates(
  t: TFunction<'table'>,
): KitableTemplateDefinition[] {
  const templates: KitableTemplateSeed[] = [
    createTaskTrackerTemplate(t),
    createThumbnailGeneratorTemplate(t),
    createReceiptOcrTemplate(t),
    {
      id: EMAIL_INBOX_SYNC_TEMPLATE_ID,
      title: t('templateLibrary.templates.emailInboxSync.title'),
      description: t('templateLibrary.templates.emailInboxSync.description'),
      documentDescription: 'Import a complete IMAP mailbox into a structured Inbox table with Markdown-backed message records.',
      usageCount: 628,
      icon: 'mail',
      color: 'violet',
      localOnly: true,
      afterCreate: { type: 'email-sync', runAfterSave: 'full' },
      tables: [{
        title: 'Inbox',
        description: 'Synchronized mailbox messages and local document links.',
        fields: [
          { title: 'Subject', type: 'text', primary: true, readonly: true },
          { title: 'From', type: 'text', readonly: true },
          { title: 'To', type: 'long_text', readonly: true },
          { title: 'Received At', type: 'datetime', readonly: true },
          { title: 'Mailbox', type: 'single_select', readonly: true, options: { choices: ['INBOX'] } },
          { title: 'Preview', type: 'long_text', readonly: true },
          { title: 'Has Attachments', type: 'checkbox', readonly: true },
          { title: 'Status', type: 'single_select', readonly: true, options: { choices: ['Imported', 'Updated', 'Error'] } },
          { title: 'Message ID', type: 'text', readonly: true },
          { title: 'Document', type: 'document_link', readonly: true },
        ],
        views: [gridView],
        records: [],
      }],
    },
    {
      id: 'leads-landing-page',
      title: t('templateLibrary.templates.leadsLandingPage.title'),
      description: t('templateLibrary.templates.leadsLandingPage.description'),
      documentDescription: 'Capture qualified leads from a public form and manage follow-up.',
      usageCount: 1307,
      icon: 'contact',
      color: 'sky',
      tables: [{
        title: 'Leads',
        description: 'Landing-page submissions and qualification status.',
        fields: [
          { title: 'Company', type: 'text', primary: true },
          { title: 'Contact name', type: 'text' },
          { title: 'Work email', type: 'text' },
          { title: 'Company size', type: 'single_select', options: { choices: ['1–10', '11–50', '51–200', '201–1000', '1000+'] } },
          { title: 'Use case', type: 'multi_select', options: { choices: ['CRM', 'Operations', 'Content', 'Project management', 'Customer support'] } },
          { title: 'Source', type: 'single_select', options: { choices: ['Organic search', 'Partner', 'Social', 'Event', 'Referral'] } },
          { title: 'Stage', type: 'single_select', options: { choices: ['New', 'Qualified', 'Demo booked', 'Nurture', 'Closed'] } },
          { title: 'Estimated value', type: 'number' },
          { title: 'Submitted at', type: 'datetime' },
          { title: 'Notes', type: 'long_text' },
        ],
        views: [{ title: 'Lead form', type: 'form' }, gridView, { title: 'Pipeline', type: 'kanban' }],
        records: [
          { Company: 'Northstar Labs', 'Contact name': 'Emma Stone', 'Work email': 'emma@northstarlabs.example', 'Company size': '51–200', 'Use case': ['Operations', 'Project management'], Source: 'Organic search', Stage: 'Demo booked', 'Estimated value': 18000, 'Submitted at': '2026-07-28T09:12:00Z', Notes: 'Needs approval workflows and audit history.' },
          { Company: 'Cedar & Finch', 'Contact name': 'Theo Martin', 'Work email': 'theo@cedarfinch.example', 'Company size': '11–50', 'Use case': ['CRM'], Source: 'Referral', Stage: 'Qualified', 'Estimated value': 9000, 'Submitted at': '2026-07-27T16:40:00Z', Notes: 'Replacing several disconnected spreadsheets.' },
          { Company: 'Atlas Freight', 'Contact name': 'Priya Nair', 'Work email': 'priya@atlasfreight.example', 'Company size': '201–1000', 'Use case': ['Operations', 'Customer support'], Source: 'Event', Stage: 'New', 'Estimated value': 42000, 'Submitted at': '2026-07-28T03:28:00Z' },
          { Company: 'Brightline Studio', 'Contact name': 'Milo Grant', 'Work email': 'milo@brightline.example', 'Company size': '11–50', 'Use case': ['Content', 'Project management'], Source: 'Social', Stage: 'Nurture', 'Estimated value': 6000, 'Submitted at': '2026-07-24T11:05:00Z', Notes: 'Revisit after current client delivery cycle.' },
          { Company: 'Harbor Health', 'Contact name': 'Leah Cooper', 'Work email': 'leah@harborhealth.example', 'Company size': '1000+', 'Use case': ['Customer support'], Source: 'Partner', Stage: 'Demo booked', 'Estimated value': 68000, 'Submitted at': '2026-07-25T14:22:00Z', Notes: 'Security review required before pilot.' },
          { Company: 'Fieldwork Coffee', 'Contact name': 'Jon Bell', 'Work email': 'jon@fieldwork.example', 'Company size': '1–10', 'Use case': ['CRM', 'Operations'], Source: 'Organic search', Stage: 'Closed', 'Estimated value': 2400, 'Submitted at': '2026-07-18T08:30:00Z' },
          { Company: 'Signal Ridge', 'Contact name': 'Iris Wong', 'Work email': 'iris@signalridge.example', 'Company size': '51–200', 'Use case': ['Project management'], Source: 'Referral', Stage: 'Qualified', 'Estimated value': 15000, 'Submitted at': '2026-07-26T19:14:00Z' },
          { Company: 'Pioneer Works', 'Contact name': 'Sam Wilson', 'Work email': 'sam@pioneerworks.example', 'Company size': '201–1000', 'Use case': ['Operations'], Source: 'Event', Stage: 'New', 'Estimated value': 31000, 'Submitted at': '2026-07-28T06:55:00Z' },
        ],
      }],
    },
    {
      id: 'sdr-cold-call-manager',
      title: t('templateLibrary.templates.sdrColdCallManager.title'),
      description: t('templateLibrary.templates.sdrColdCallManager.description'),
      documentDescription: 'Manage SDR call queues, attempts, outcomes, and next steps.',
      usageCount: 2289,
      icon: 'phone',
      color: 'violet',
      tables: [{
        title: 'Call Queue',
        description: 'Prioritized outbound calling list for sales development.',
        fields: [
          { title: 'Account', type: 'text', primary: true },
          { title: 'Contact', type: 'text' },
          { title: 'Phone', type: 'text' },
          { title: 'Territory', type: 'single_select', options: { choices: ['North America', 'Europe', 'Asia Pacific', 'Latin America'] } },
          { title: 'Priority', type: 'single_select', options: { choices: ['Low', 'Medium', 'High'] } },
          { title: 'Call stage', type: 'single_select', options: { choices: ['Ready', 'Attempted', 'Connected', 'Meeting booked', 'Do not call'] } },
          { title: 'Attempts', type: 'number' },
          { title: 'Last call', type: 'datetime' },
          { title: 'Next call', type: 'datetime' },
          { title: 'Owner', type: 'text' },
          { title: 'Call notes', type: 'long_text' },
        ],
        views: [gridView, { title: 'Call stages', type: 'kanban' }, { title: 'Call calendar', type: 'calendar' }],
        records: [
          { Account: 'Acme Robotics', Contact: 'Daniel Ruiz', Phone: '+1 555 010 2210', Territory: 'North America', Priority: 'High', 'Call stage': 'Ready', Attempts: 0, 'Next call': '2026-07-28T15:00:00Z', Owner: 'Alex Carter', 'Call notes': 'Recently expanded operations team.' },
          { Account: 'Bluebird Energy', Contact: 'Nora Jensen', Phone: '+45 70 20 11 44', Territory: 'Europe', Priority: 'High', 'Call stage': 'Connected', Attempts: 2, 'Last call': '2026-07-27T10:20:00Z', 'Next call': '2026-07-30T09:00:00Z', Owner: 'Alex Carter', 'Call notes': 'Interested in workflow automation and reporting.' },
          { Account: 'Canyon Foods', Contact: 'Marcus Hill', Phone: '+1 555 010 7844', Territory: 'North America', Priority: 'Medium', 'Call stage': 'Attempted', Attempts: 1, 'Last call': '2026-07-28T08:45:00Z', 'Next call': '2026-07-29T16:30:00Z', Owner: 'Taylor Reed' },
          { Account: 'Delta Marine', Contact: 'Hana Ito', Phone: '+81 3 5550 3100', Territory: 'Asia Pacific', Priority: 'High', 'Call stage': 'Meeting booked', Attempts: 3, 'Last call': '2026-07-26T04:10:00Z', 'Next call': '2026-08-01T05:00:00Z', Owner: 'Morgan Blake', 'Call notes': 'Discovery with operations director and IT lead.' },
          { Account: 'Evergreen Legal', Contact: 'Amelia Hart', Phone: '+44 20 7946 0230', Territory: 'Europe', Priority: 'Medium', 'Call stage': 'Ready', Attempts: 0, 'Next call': '2026-07-29T11:00:00Z', Owner: 'Taylor Reed' },
          { Account: 'Futura Retail', Contact: 'Lucas Silva', Phone: '+55 11 5555 0199', Territory: 'Latin America', Priority: 'Medium', 'Call stage': 'Attempted', Attempts: 2, 'Last call': '2026-07-25T17:35:00Z', 'Next call': '2026-07-31T17:00:00Z', Owner: 'Morgan Blake' },
          { Account: 'Granite Systems', Contact: 'Chloe Baker', Phone: '+1 555 010 9942', Territory: 'North America', Priority: 'Low', 'Call stage': 'Do not call', Attempts: 4, 'Last call': '2026-07-23T14:15:00Z', Owner: 'Alex Carter', 'Call notes': 'Requested removal from outbound list.' },
          { Account: 'Helio Networks', Contact: 'Arjun Mehta', Phone: '+91 80 5550 6110', Territory: 'Asia Pacific', Priority: 'High', 'Call stage': 'Connected', Attempts: 1, 'Last call': '2026-07-28T06:10:00Z', 'Next call': '2026-07-30T06:30:00Z', Owner: 'Taylor Reed', 'Call notes': 'Send architecture overview before follow-up.' },
        ],
      }],
    },
    {
      id: 'product-launch-website',
      title: t('templateLibrary.templates.productLaunchWebsite.title'),
      description: t('templateLibrary.templates.productLaunchWebsite.description'),
      documentDescription: 'Coordinate a premium product launch site from concept through publication.',
      usageCount: 1051,
      icon: 'rocket',
      color: 'slate',
      tables: [{
        title: 'Website Sections',
        description: 'Launch-site sections, content ownership, assets, and readiness.',
        fields: [
          { title: 'Section', type: 'text', primary: true },
          { title: 'Purpose', type: 'long_text' },
          { title: 'Headline', type: 'text' },
          { title: 'Owner', type: 'text' },
          { title: 'Status', type: 'single_select', options: { choices: ['Draft', 'Design', 'Review', 'Ready', 'Published'] } },
          { title: 'Publish date', type: 'date' },
          { title: 'Asset URL', type: 'url' },
          { title: 'Mobile ready', type: 'checkbox' },
          { title: 'Notes', type: 'long_text' },
        ],
        views: [gridView, { title: 'Production board', type: 'kanban' }, { title: 'Launch calendar', type: 'calendar' }],
        records: [
          { Section: 'Hero', Purpose: 'Introduce the product with one clear promise.', Headline: 'A cleaner home, without the daily effort.', Owner: 'Nina Cole', Status: 'Ready', 'Publish date': '2026-08-18', 'Asset URL': 'https://example.com/assets/hero', 'Mobile ready': true, Notes: 'Use the side profile as the primary product angle.' },
          { Section: 'Problem', Purpose: 'Show the cost of repeated manual cleaning.', Headline: 'Clean floors should not take over your week.', Owner: 'Omar Lewis', Status: 'Review', 'Publish date': '2026-08-18', 'Mobile ready': true },
          { Section: 'Feature overview', Purpose: 'Explain navigation, obstacle detection, and quiet mode.', Headline: 'Built to notice what other cleaners miss.', Owner: 'Nina Cole', Status: 'Design', 'Publish date': '2026-08-18', 'Asset URL': 'https://example.com/assets/features', 'Mobile ready': false },
          { Section: 'Product gallery', Purpose: 'Present premium product details and finishes.', Headline: 'Designed to belong in your home.', Owner: 'Jules Kim', Status: 'Ready', 'Publish date': '2026-08-18', 'Asset URL': 'https://example.com/assets/gallery', 'Mobile ready': true },
          { Section: 'Specifications', Purpose: 'Answer practical purchase questions.', Headline: 'Powerful where it matters. Quiet everywhere else.', Owner: 'Omar Lewis', Status: 'Draft', 'Publish date': '2026-08-18', 'Mobile ready': false },
          { Section: 'Reviews', Purpose: 'Build confidence with early customer feedback.', Headline: 'A small machine that gives time back.', Owner: 'Tessa Moore', Status: 'Review', 'Publish date': '2026-08-18', 'Mobile ready': true },
          { Section: 'Purchase', Purpose: 'Present packages, shipping, and final call to action.', Headline: 'Choose your finish and start cleaning less.', Owner: 'Tessa Moore', Status: 'Draft', 'Publish date': '2026-08-18', 'Mobile ready': false, Notes: 'Waiting for final bundle pricing.' },
        ],
      }],
    },
    createBatchProductDesignerTemplate(t),
    {
      id: 'simple-client-crm',
      title: t('templateLibrary.templates.simpleClientCrm.title'),
      description: t('templateLibrary.templates.simpleClientCrm.description'),
      documentDescription: 'Track prospects, active clients, quotes, and follow-up in one workspace.',
      usageCount: 3695,
      icon: 'handshake',
      color: 'sky',
      tables: [
        {
          title: 'Clients',
          description: 'Client relationships from first conversation through renewal.',
          fields: [
            { title: 'Company', type: 'text', primary: true },
            { title: 'Primary contact', type: 'text' },
            { title: 'Email', type: 'text' },
            { title: 'Stage', type: 'single_select', options: { choices: ['Lead', 'Discovery', 'Proposal', 'Active', 'Renewal', 'Closed'] } },
            { title: 'Deal value', type: 'number' },
            { title: 'Owner', type: 'text' },
            { title: 'Next follow-up', type: 'date' },
            { title: 'Services', type: 'multi_select', options: { choices: ['Strategy', 'Design', 'Development', 'Support', 'Training'] } },
            { title: 'Health', type: 'single_select', options: { choices: ['Strong', 'Watch', 'At risk'] } },
            { title: 'Notes', type: 'long_text' },
          ],
          views: [gridView, { title: 'Sales pipeline', type: 'kanban' }, { title: 'Follow-up calendar', type: 'calendar' }],
          records: [
            { Company: 'Alpine Goods', 'Primary contact': 'Rebecca Hall', Email: 'rebecca@alpinegoods.example', Stage: 'Active', 'Deal value': 48000, Owner: 'Chris Lane', 'Next follow-up': '2026-08-03', Services: ['Strategy', 'Development'], Health: 'Strong', Notes: 'Expansion discussion scheduled for Q4.' },
            { Company: 'Beacon Media', 'Primary contact': 'Drew Evans', Email: 'drew@beaconmedia.example', Stage: 'Proposal', 'Deal value': 22000, Owner: 'Chris Lane', 'Next follow-up': '2026-07-30', Services: ['Design', 'Development'], Health: 'Strong' },
            { Company: 'Clover Finance', 'Primary contact': 'Fatima Noor', Email: 'fatima@cloverfinance.example', Stage: 'Discovery', 'Deal value': 36000, Owner: 'Robin Fox', 'Next follow-up': '2026-07-31', Services: ['Strategy', 'Training'], Health: 'Watch', Notes: 'Procurement timeline is still unclear.' },
            { Company: 'Drift Hotel Group', 'Primary contact': 'Ethan Price', Email: 'ethan@drifthotel.example', Stage: 'Renewal', 'Deal value': 64000, Owner: 'Robin Fox', 'Next follow-up': '2026-08-05', Services: ['Support', 'Development'], Health: 'Strong' },
            { Company: 'Elm Education', 'Primary contact': 'Zoe King', Email: 'zoe@elmeducation.example', Stage: 'Lead', 'Deal value': 12000, Owner: 'Chris Lane', 'Next follow-up': '2026-08-01', Services: ['Training'], Health: 'Watch' },
            { Company: 'Foundry Labs', 'Primary contact': 'Ben Ortiz', Email: 'ben@foundrylabs.example', Stage: 'Active', 'Deal value': 31000, Owner: 'Morgan Yu', 'Next follow-up': '2026-08-07', Services: ['Design', 'Development', 'Support'], Health: 'At risk', Notes: 'Resolve delivery concerns before the next steering call.' },
            { Company: 'Greenway Market', 'Primary contact': 'Alice Young', Email: 'alice@greenway.example', Stage: 'Closed', 'Deal value': 8000, Owner: 'Morgan Yu', 'Next follow-up': '2026-09-15', Services: ['Strategy'], Health: 'Strong' },
            { Company: 'Horizon Mobility', 'Primary contact': 'Ken Adams', Email: 'ken@horizonmobility.example', Stage: 'Proposal', 'Deal value': 57000, Owner: 'Robin Fox', 'Next follow-up': '2026-07-29', Services: ['Strategy', 'Development', 'Training'], Health: 'Strong' },
          ],
        },
        {
          title: 'Quotes',
          description: 'Commercial quotes and approval progress.',
          fields: [
            { title: 'Quote', type: 'text', primary: true },
            { title: 'Client', type: 'text' },
            { title: 'Amount', type: 'number' },
            { title: 'Status', type: 'single_select', options: { choices: ['Draft', 'Sent', 'Accepted', 'Declined', 'Expired'] } },
            { title: 'Sent date', type: 'date' },
            { title: 'Valid until', type: 'date' },
            { title: 'Owner', type: 'text' },
          ],
          views: [gridView, { title: 'Quote status', type: 'kanban' }],
          records: [
            { Quote: 'Q-2026-104', Client: 'Beacon Media', Amount: 22000, Status: 'Sent', 'Sent date': '2026-07-24', 'Valid until': '2026-08-14', Owner: 'Chris Lane' },
            { Quote: 'Q-2026-105', Client: 'Horizon Mobility', Amount: 57000, Status: 'Draft', 'Valid until': '2026-08-20', Owner: 'Robin Fox' },
            { Quote: 'Q-2026-097', Client: 'Alpine Goods', Amount: 48000, Status: 'Accepted', 'Sent date': '2026-06-12', 'Valid until': '2026-07-03', Owner: 'Chris Lane' },
            { Quote: 'Q-2026-099', Client: 'Greenway Market', Amount: 8000, Status: 'Declined', 'Sent date': '2026-06-25', 'Valid until': '2026-07-16', Owner: 'Morgan Yu' },
          ],
        },
      ],
    },
    {
      id: 'lumiere-restaurant',
      title: t('templateLibrary.templates.lumiereRestaurant.title'),
      description: t('templateLibrary.templates.lumiereRestaurant.description'),
      documentDescription: 'Coordinate reservations, guest preferences, private events, and service follow-up.',
      usageCount: 2874,
      icon: 'utensils',
      color: 'amber',
      afterCreate: {
        type: 'form-sync',
        name: 'Private Event Inquiry',
        templateId: 'lumiere-restaurant',
        tableTitle: 'Private Events',
        fields: [
          { key: 'event', label: 'Event', type: 'text', required: true },
          { key: 'host', label: 'Host', type: 'text', required: true },
          { key: 'email', label: 'Email', type: 'email', required: true },
          { key: 'phone', label: 'Phone', type: 'phone', required: false },
          { key: 'event_date', label: 'Event date', type: 'datetime', required: true },
          { key: 'guests', label: 'Guests', type: 'number', required: true },
          { key: 'room', label: 'Preferred room', type: 'select', required: false, options: ['Salon', 'Terrace', 'Full venue'] },
          { key: 'budget', label: 'Budget', type: 'number', required: false },
          { key: 'menu_notes', label: 'Menu notes', type: 'long_text', required: false },
        ],
        fieldMappings: [
          { sourceKey: 'event', targetFieldTitle: 'Event' },
          { sourceKey: 'host', targetFieldTitle: 'Host' },
          { sourceKey: 'email', targetFieldTitle: 'Email' },
          { sourceKey: 'phone', targetFieldTitle: 'Phone' },
          { sourceKey: 'event_date', targetFieldTitle: 'Event date' },
          { sourceKey: 'guests', targetFieldTitle: 'Guests' },
          { sourceKey: 'room', targetFieldTitle: 'Room' },
          { sourceKey: 'budget', targetFieldTitle: 'Budget' },
          { sourceKey: 'menu_notes', targetFieldTitle: 'Menu notes' },
        ],
        defaults: [
          { targetFieldTitle: 'Status', value: 'Inquiry' },
          { targetFieldTitle: 'Source', value: 'Kition Cloud form' },
        ],
        submissionIdFieldTitle: 'Submission ID',
        submittedAtFieldTitle: 'Submitted At',
        intervalMinutes: 5,
      },
      tables: [
        {
          title: 'Reservations',
          description: 'Dining reservations, service details, and guest preferences.',
          fields: [
            { title: 'Guest', type: 'text', primary: true },
            { title: 'Reservation time', type: 'datetime' },
            { title: 'Party size', type: 'number' },
            { title: 'Experience', type: 'single_select', options: { choices: ['Dining room', 'Chef counter', 'Terrace', 'Private room'] } },
            { title: 'Status', type: 'single_select', options: { choices: ['Requested', 'Confirmed', 'Seated', 'Completed', 'Cancelled'] } },
            { title: 'Phone', type: 'text' },
            { title: 'Occasion', type: 'single_select', options: { choices: ['None', 'Birthday', 'Anniversary', 'Business', 'Celebration'] } },
            { title: 'Dietary notes', type: 'long_text' },
            { title: 'VIP', type: 'checkbox' },
            { title: 'Table', type: 'text' },
          ],
          views: [{ title: 'Service calendar', type: 'calendar' }, gridView, { title: 'Service status', type: 'kanban' }],
          records: [
            { Guest: 'Aisha Morgan', 'Reservation time': '2026-08-03T18:00:00Z', 'Party size': 2, Experience: 'Terrace', Status: 'Confirmed', Phone: '+1 555 016 2201', Occasion: 'Anniversary', 'Dietary notes': 'One guest requests a dairy-free menu.', VIP: true, Table: 'T3' },
            { Guest: 'Daniel Kim', 'Reservation time': '2026-08-03T18:45:00Z', 'Party size': 4, Experience: 'Dining room', Status: 'Seated', Phone: '+1 555 016 2202', Occasion: 'Business', VIP: false, Table: 'D8' },
            { Guest: 'Priya Shah', 'Reservation time': '2026-08-03T19:15:00Z', 'Party size': 3, Experience: 'Chef counter', Status: 'Requested', Phone: '+1 555 016 2203', Occasion: 'Birthday', 'Dietary notes': 'Vegetarian menu for the full party.', VIP: false, Table: 'Counter 3' },
            { Guest: 'Noah Williams', 'Reservation time': '2026-08-03T20:00:00Z', 'Party size': 2, Experience: 'Dining room', Status: 'Completed', Phone: '+1 555 016 2204', Occasion: 'None', VIP: false, Table: 'D4' },
            { Guest: 'Elena Torres', 'Reservation time': '2026-08-04T18:30:00Z', 'Party size': 7, Experience: 'Private room', Status: 'Confirmed', Phone: '+1 555 016 2205', Occasion: 'Celebration', 'Dietary notes': 'Gluten-free bread and a nut-free dessert.', VIP: true, Table: 'Private B' },
            { Guest: 'Marcus Lee', 'Reservation time': '2026-08-04T19:00:00Z', 'Party size': 5, Experience: 'Terrace', Status: 'Confirmed', Phone: '+1 555 016 2206', Occasion: 'Business', VIP: false, Table: 'T6' },
            { Guest: 'Grace Miller', 'Reservation time': '2026-08-04T20:15:00Z', 'Party size': 2, Experience: 'Chef counter', Status: 'Cancelled', Phone: '+1 555 016 2207', Occasion: 'Birthday', VIP: false, Table: 'Counter 1' },
            { Guest: 'Owen Parker', 'Reservation time': '2026-08-05T19:30:00Z', 'Party size': 6, Experience: 'Dining room', Status: 'Requested', Phone: '+1 555 016 2208', Occasion: 'Celebration', 'Dietary notes': 'Wheelchair-accessible seating required.', VIP: true, Table: 'D14' },
          ],
        },
        {
          title: 'Private Events',
          description: 'Private dining inquiries and event delivery details.',
          fields: [
            { title: 'Event', type: 'text', primary: true },
            { title: 'Host', type: 'text' },
            { title: 'Email', type: 'text' },
            { title: 'Phone', type: 'text' },
            { title: 'Event date', type: 'datetime' },
            { title: 'Guests', type: 'number' },
            { title: 'Room', type: 'single_select', options: { choices: ['Salon', 'Terrace', 'Full venue'] } },
            { title: 'Status', type: 'single_select', options: { choices: ['Inquiry', 'Qualified', 'Proposal', 'Confirmed', 'Completed', 'Declined'] } },
            { title: 'Budget', type: 'number' },
            { title: 'Menu notes', type: 'long_text' },
            { title: 'Submitted At', type: 'datetime', readonly: true },
            { title: 'Source', type: 'single_select', readonly: true, options: { choices: ['Kition Cloud form', 'Manual'] } },
            { title: 'Submission ID', type: 'text', readonly: true },
          ],
          views: [gridView, { title: 'Event inquiry form', type: 'form' }, { title: 'Event calendar', type: 'calendar' }, { title: 'Event pipeline', type: 'kanban' }],
          records: [
            { Event: 'Northstar quarterly dinner', Host: 'Maya Collins', 'Event date': '2026-08-14T18:00:00Z', Guests: 20, Room: 'Salon', Status: 'Confirmed', Budget: 6200, 'Menu notes': 'Seasonal shared menu with non-alcoholic pairings.' },
            { Event: 'Harbor Foundation fundraiser', Host: 'Ethan Brooks', 'Event date': '2026-08-27T17:30:00Z', Guests: 64, Room: 'Full venue', Status: 'Proposal', Budget: 19500, 'Menu notes': 'Reception stations, short program, and accessible seating plan.' },
            { Event: 'Cedar Studio product preview', Host: 'Lena Ortiz', 'Event date': '2026-09-10T18:30:00Z', Guests: 38, Room: 'Terrace', Status: 'Qualified', Budget: 12400, 'Menu notes': 'Passed plates, branded menu cards, and a zero-proof cocktail bar.' },
            { Event: 'Lakeside family reception', Host: 'Jordan Blake', 'Event date': '2026-09-19T19:00:00Z', Guests: 28, Room: 'Salon', Status: 'Inquiry', Budget: 8400, 'Menu notes': 'Family-style dinner with a children menu for six guests.' },
          ],
        },
      ],
    },
  ]

  const builtInTemplates: KitableTemplateDefinition[] = templates.map((template) => ({
    ...template,
    coverImage: `/templates/table-covers/${template.id}.webp`,
    categories: solutionCategories[template.id] || ['recommended'],
    snapshot: {
      version: template.id === 'thumbnail-generator'
        ? 5
        : template.id === 'batch-product-designer'
          ? 3
          : template.id === 'lumiere-restaurant'
            ? 2
          : template.id === 'task-tracker'
            ? 2
            : 1,
      includeData: template.id !== EMAIL_INBOX_SYNC_TEMPLATE_ID,
      ...solutionResources[template.id],
    },
  }))
  return [...builtInTemplates, ...getOperationalKitableTemplates()]
}
