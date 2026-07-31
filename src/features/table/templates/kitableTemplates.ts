import type { TFunction } from 'i18next'

import type {
  DataDashboardSeed,
  DataFieldSeed,
  DataRecordValue,
  DataViewSeed,
} from '@/types/dataDocument'
import type { AnyAIConfig } from '@/types/aiConfig'
import { createBatchProductDesignerTemplate } from './batchProductDesignerTemplate'
import { getOperationalKitableTemplates } from './kitableOperationalTemplates'
import { createTaskTrackerTemplate } from './taskTrackerTemplate'
import { createThumbnailGeneratorTemplate } from './thumbnailGeneratorTemplate'

export type KitableTemplateCategory =
  | 'recommended'
  | 'popular'
  | 'ai-workflows'
  | 'information-collection'
  | 'data-analysis'
  | 'commerce'
  | 'sales'
  | 'performance'
  | 'administration'
  | 'human-resources'
  | 'project-management'
  | 'collaboration'
  | 'marketing'
  | 'personal-growth'

export type KitableTemplatePreview =
  | 'call-queue'
  | 'crm'
  | 'designer'
  | 'landing-page'
  | 'product-launch'
  | 'restaurant'
  | 'task-tracker'
  | 'thumbnail-generator'

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
  preview: KitableTemplatePreview
  icon: string
  color: string
  categories?: KitableTemplateCategory[]
  snapshot: KitableTemplateSnapshot
  tables: KitableTemplateTable[]
  dashboards?: DataDashboardSeed[]
  assetManifestPath?: string
}

const gridView: DataViewSeed = { title: 'Grid', type: 'grid' }

export type KitableTemplateSeed = Omit<KitableTemplateDefinition, 'snapshot'>

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
      { id: 'guest-confirmations', kind: 'automation', title: 'Guest confirmations', description: 'Coordinates reservation and event confirmations.' },
    ],
  },
}

const solutionCategories: Record<string, KitableTemplateCategory[]> = {
  'task-tracker': ['recommended', 'project-management', 'collaboration'],
  'thumbnail-generator': ['recommended', 'ai-workflows', 'marketing'],
  'leads-landing-page': ['recommended', 'information-collection', 'sales'],
  'sdr-cold-call-manager': ['ai-workflows', 'sales'],
  'product-launch-website': ['recommended', 'popular', 'marketing'],
  'batch-product-designer': ['popular', 'ai-workflows', 'commerce'],
  'simple-client-crm': ['recommended', 'popular', 'sales'],
  'lumiere-restaurant': ['popular', 'commerce'],
}

export function getBuiltinKitableTemplates(
  t: TFunction<'table'>,
): KitableTemplateDefinition[] {
  const templates: KitableTemplateSeed[] = [
    createTaskTrackerTemplate(t),
    createThumbnailGeneratorTemplate(t),
    {
      id: 'leads-landing-page',
      title: t('templateLibrary.templates.leadsLandingPage.title'),
      description: t('templateLibrary.templates.leadsLandingPage.description'),
      documentDescription: 'Capture qualified leads from a public form and manage follow-up.',
      usageCount: 1307,
      preview: 'landing-page',
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
      preview: 'call-queue',
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
      preview: 'product-launch',
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
      preview: 'crm',
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
      documentDescription: 'Coordinate reservations, private events, and guest notes for a fine-dining team.',
      usageCount: 1426,
      preview: 'restaurant',
      icon: 'utensils',
      color: 'amber',
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
            { Guest: 'Olivia Bennett', 'Reservation time': '2026-07-28T18:30:00Z', 'Party size': 2, Experience: 'Chef counter', Status: 'Confirmed', Phone: '+1 555 010 4401', Occasion: 'Anniversary', 'Dietary notes': 'One guest avoids shellfish.', VIP: true, Table: 'Counter 2' },
            { Guest: 'Henry Walker', 'Reservation time': '2026-07-28T19:00:00Z', 'Party size': 4, Experience: 'Dining room', Status: 'Confirmed', Phone: '+1 555 010 4402', Occasion: 'Business', VIP: false, Table: 'D12' },
            { Guest: 'Sophia Laurent', 'Reservation time': '2026-07-28T19:30:00Z', 'Party size': 3, Experience: 'Terrace', Status: 'Requested', Phone: '+33 1 55 50 4403', Occasion: 'Birthday', 'Dietary notes': 'Vegetarian tasting menu requested.', VIP: true, Table: 'T4' },
            { Guest: 'Mateo Garcia', 'Reservation time': '2026-07-28T20:00:00Z', 'Party size': 2, Experience: 'Dining room', Status: 'Seated', Phone: '+34 91 555 4404', Occasion: 'None', VIP: false, Table: 'D6' },
            { Guest: 'Amelia Scott', 'Reservation time': '2026-07-29T18:00:00Z', 'Party size': 6, Experience: 'Private room', Status: 'Confirmed', Phone: '+44 20 7555 4405', Occasion: 'Celebration', 'Dietary notes': 'Gluten-free bread for two guests.', VIP: true, Table: 'Private A' },
            { Guest: 'Jackson Reed', 'Reservation time': '2026-07-29T20:30:00Z', 'Party size': 2, Experience: 'Terrace', Status: 'Cancelled', Phone: '+1 555 010 4406', Occasion: 'None', VIP: false, Table: 'T2' },
            { Guest: 'Isabella Rossi', 'Reservation time': '2026-07-30T19:15:00Z', 'Party size': 5, Experience: 'Dining room', Status: 'Confirmed', Phone: '+39 06 555 4407', Occasion: 'Birthday', 'Dietary notes': 'Nut allergy at the table.', VIP: false, Table: 'D15' },
            { Guest: 'William Chen', 'Reservation time': '2026-07-30T20:00:00Z', 'Party size': 2, Experience: 'Chef counter', Status: 'Requested', Phone: '+65 6555 4408', Occasion: 'Anniversary', VIP: true, Table: 'Counter 4' },
          ],
        },
        {
          title: 'Private Events',
          description: 'Private dining inquiries and event delivery details.',
          fields: [
            { title: 'Event', type: 'text', primary: true },
            { title: 'Host', type: 'text' },
            { title: 'Event date', type: 'datetime' },
            { title: 'Guests', type: 'number' },
            { title: 'Room', type: 'single_select', options: { choices: ['Salon', 'Terrace', 'Full venue'] } },
            { title: 'Status', type: 'single_select', options: { choices: ['Inquiry', 'Proposal', 'Confirmed', 'Completed'] } },
            { title: 'Budget', type: 'number' },
            { title: 'Menu notes', type: 'long_text' },
          ],
          views: [gridView, { title: 'Event calendar', type: 'calendar' }, { title: 'Event pipeline', type: 'kanban' }],
          records: [
            { Event: 'Aster Labs leadership dinner', Host: 'Megan Price', 'Event date': '2026-08-12T18:00:00Z', Guests: 18, Room: 'Salon', Status: 'Confirmed', Budget: 5400, 'Menu notes': 'Seasonal tasting menu with non-alcoholic pairing.' },
            { Event: 'Summer design showcase', Host: 'Leo Grant', 'Event date': '2026-08-21T17:30:00Z', Guests: 42, Room: 'Terrace', Status: 'Proposal', Budget: 11000, 'Menu notes': 'Passed plates and two signature cocktails.' },
            { Event: 'Family celebration', Host: 'Nadia Foster', 'Event date': '2026-09-05T19:00:00Z', Guests: 26, Room: 'Salon', Status: 'Inquiry', Budget: 7200, 'Menu notes': 'Children menu needed for four guests.' },
            { Event: 'Maison Aurelia press evening', Host: 'Claire Martin', 'Event date': '2026-09-18T18:30:00Z', Guests: 70, Room: 'Full venue', Status: 'Confirmed', Budget: 24000, 'Menu notes': 'Brand colors reflected in floral and dessert presentation.' },
          ],
        },
      ],
    },
  ]

  const builtInTemplates: KitableTemplateDefinition[] = templates.map((template) => ({
    ...template,
    categories: solutionCategories[template.id] || ['recommended'],
    snapshot: {
      version: template.id === 'thumbnail-generator'
        ? 5
        : template.id === 'batch-product-designer'
          ? 3
          : template.id === 'task-tracker'
            ? 2
            : 1,
      includeData: true,
      ...solutionResources[template.id],
    },
  }))
  return [...builtInTemplates, ...getOperationalKitableTemplates()]
}
