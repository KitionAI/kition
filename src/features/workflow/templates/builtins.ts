import type { WorkflowTemplate } from './index'

export type TemplateTranslator = (key: string) => string

export function buildBuiltinTemplates(t: TemplateTranslator): WorkflowTemplate[] {
  return [
    {
      id: 'content-idea-to-publishing-queue',
      name: t('templates.contentIdeaToQueue.name'),
      description: t('templates.contentIdeaToQueue.description'),
      icons: [{ kind: 'lucide', name: 'FileText' }, { kind: 'lucide', name: 'Database' }],
      sourceTableNames: ['Content Ideas'],
      enabledByDefault: true,
      draft: {
        name: t('templates.contentIdeaToQueue.name'),
        description: t('templates.contentIdeaToQueue.description'),
        trigger: {
          type: 'record_created',
          requiredFieldNames: ['Idea', 'Channel', 'Priority', 'Status'],
        },
        action: {
          type: 'add_record',
          targetTableName: 'Publishing Queue',
          fields: [
            { targetFieldName: 'Title', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Idea', fallback: '(untitled idea)' }] },
            { targetFieldName: 'Channel', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Channel', fallback: '' }] },
            { targetFieldName: 'Priority', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Priority', fallback: '' }] },
            { targetFieldName: 'Source Status', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Status', fallback: '' }] },
            { targetFieldName: 'Automation Note', valueParts: [{ kind: 'text', text: 'Added automatically by workflow' }] },
          ],
        },
      },
    },
    {
      id: 'archive-completed-tasks',
      name: t('templates.archiveCompletedTasks.name'),
      description: t('templates.archiveCompletedTasks.description'),
      icons: [{ kind: 'lucide', name: 'FileText' }, { kind: 'lucide', name: 'Database' }],
      sourceTableNames: ['Tasks'],
      enabledByDefault: true,
      draft: {
        name: t('templates.archiveCompletedTasks.name'),
        description: t('templates.archiveCompletedTasks.description'),
        trigger: {
          type: 'record_updated',
          requiredFieldNames: ['Name', 'Status'],
        },
        filter: {
          mode: 'all',
          conditions: [{ fieldName: 'Status', op: '==', value: 'Done' }],
        },
        action: {
          type: 'add_record',
          targetTableName: 'Completed Tasks',
          fields: [
            { targetFieldName: 'Task', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Name', fallback: '(untitled task)' }] },
            { targetFieldName: 'Status', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Status', fallback: '' }] },
            { targetFieldName: 'Due', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Due', fallback: '' }] },
            { targetFieldName: 'Notes', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Notes', fallback: '' }] },
            { targetFieldName: 'Automation Note', valueParts: [{ kind: 'text', text: 'Archived automatically when the task reached Done' }] },
          ],
        },
      },
    },
    {
      id: 'weekday-priority-planning',
      name: t('templates.weekdayPriorityPlanning.name'),
      description: t('templates.weekdayPriorityPlanning.description'),
      icons: [{ kind: 'lucide', name: 'CalendarClock' }, { kind: 'lucide', name: 'Plus' }],
      sourceTableNames: ['Tasks'],
      enabledByDefault: true,
      draft: {
        name: t('templates.weekdayPriorityPlanning.name'),
        description: t('templates.weekdayPriorityPlanning.description'),
        trigger: { type: 'scheduled_time', schedule: { cron: '0 9 * * 1-5' } },
        action: {
          type: 'add_record',
          targetTableName: 'Tasks',
          fields: [
            { targetFieldName: 'Name', valueParts: [{ kind: 'text', text: "Plan today's priorities" }] },
            { targetFieldName: 'Status', valueParts: [{ kind: 'text', text: 'Todo' }] },
            { targetFieldName: 'Notes', valueParts: [{ kind: 'text', text: 'Created automatically every weekday at 09:00' }] },
          ],
        },
      },
    },
    {
      id: 'reading-progress-journal',
      name: t('templates.readingProgressJournal.name'),
      description: t('templates.readingProgressJournal.description'),
      icons: [{ kind: 'lucide', name: 'FileText' }, { kind: 'lucide', name: 'Database' }],
      sourceTableNames: ['Reading List'],
      enabledByDefault: true,
      draft: {
        name: t('templates.readingProgressJournal.name'),
        description: t('templates.readingProgressJournal.description'),
        trigger: {
          type: 'record_created_or_updated',
          requiredFieldNames: ['Title', 'Status'],
        },
        action: {
          type: 'add_record',
          targetTableName: 'Reading Journal',
          fields: [
            { targetFieldName: 'Article', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Title', fallback: '(untitled article)' }] },
            { targetFieldName: 'Status', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'Status', fallback: '' }] },
            { targetFieldName: 'Source URL', valueParts: [{ kind: 'field_ref_by_name', fieldName: 'URL', fallback: '' }] },
            { targetFieldName: 'Journal Note', valueParts: [{ kind: 'text', text: 'Snapshot added automatically from Reading List' }] },
          ],
        },
      },
    },
    {
      id: 'expense-high-value-review',
      name: t('templates.expenseHighValueReview.name'),
      description: t('templates.expenseHighValueReview.description'),
      icons: [{ kind: 'lucide', name: 'FileText' }, { kind: 'lucide', name: 'Sparkles' }],
      sourceTableNames: ['Expenses'],
      enabledByDefault: true,
      draft: {
        name: t('templates.expenseHighValueReview.name'),
        description: t('templates.expenseHighValueReview.description'),
        trigger: { type: 'record_created_or_updated', requiredFieldNames: ['Amount'] },
        filter: { mode: 'all', conditions: [{ fieldName: 'Amount', op: '>', value: 1000 }] },
        action: {
          type: 'update_record',
          fields: [
            { targetFieldName: 'Status', valueParts: [{ kind: 'text', text: 'Needs review' }] },
            { targetFieldName: 'Review Note', valueParts: [{ kind: 'text', text: 'Automatically flagged because the amount is above 1000' }] },
          ],
        },
      },
    },
    {
      id: 'order-catalog-enrichment',
      name: t('templates.orderCatalogEnrichment.name'),
      description: t('templates.orderCatalogEnrichment.description'),
      icons: [{ kind: 'lucide', name: 'Database' }, { kind: 'lucide', name: 'FileText' }],
      sourceTableNames: ['Orders'],
      enabledByDefault: true,
      draft: {
        name: t('templates.orderCatalogEnrichment.name'),
        description: t('templates.orderCatalogEnrichment.description'),
        trigger: { type: 'record_created_or_updated', requiredFieldNames: ['SKU'] },
        action: {
          type: 'lookup_record',
          targetTableName: 'Product Catalog',
          matchFieldName: 'SKU',
          matchValueParts: [{ kind: 'field_ref_by_name', fieldName: 'SKU', fallback: '' }],
          writeBack: [
            { sourceFieldName: 'Unit Price', targetFieldName: 'Unit Price' },
            { sourceFieldName: 'Category', targetFieldName: 'Category' },
            { sourceFieldName: 'Product Name', targetFieldName: 'Product Name' },
          ],
        },
      },
    },
    {
      id: 'normalize-contact-details',
      name: t('templates.normalizeContactDetails.name'),
      description: t('templates.normalizeContactDetails.description'),
      icons: [{ kind: 'lucide', name: 'Sparkles' }, { kind: 'lucide', name: 'Database' }],
      sourceTableNames: ['Contacts'],
      enabledByDefault: true,
      draft: {
        name: t('templates.normalizeContactDetails.name'),
        description: t('templates.normalizeContactDetails.description'),
        trigger: { type: 'record_created_or_updated', requiredFieldNames: ['Email', 'Phone'] },
        action: {
          type: 'transform_record',
          operations: [
            { sourceParts: [{ kind: 'field_ref_by_name', fieldName: 'Email', fallback: '' }], operation: 'domain_from_email', targetFieldName: 'Email Domain' },
            { sourceParts: [{ kind: 'field_ref_by_name', fieldName: 'Phone', fallback: '' }], operation: 'digits_only', targetFieldName: 'Normalized Phone' },
          ],
        },
      },
    },
    {
      id: 'email-me-on-record',
      name: t('templates.emailMeOnRecord.name'),
      description: t('templates.emailMeOnRecord.description'),
      icons: [{ kind: 'lucide', name: 'AlarmClock' }, { kind: 'lucide', name: 'Send' }],
      badgeCount: 1,
      draft: {
        name: t('templates.emailMeOnRecord.name'),
        description: '',
        trigger: { type: 'record_created' },
        action: {
          type: 'send_email',
          to: '',
          subject: 'New record added',
          bodyParts: [
            { kind: 'text', text: 'A new record was added: ' },
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: t('templates.bodyFallbacks.unnamed') },
          ],
        },
      },
    },
    {
      id: 'daily-followup-reminder',
      name: t('templates.dailyFollowupReminder.name'),
      description: t('templates.dailyFollowupReminder.description'),
      icons: [{ kind: 'lucide', name: 'AlarmClock' }, { kind: 'lucide', name: 'MessageSquare' }],
      draft: {
        name: t('templates.dailyFollowupReminder.name'),
        description: '',
        trigger: { type: 'record_created' },
        action: {
          type: 'send_email',
          to: '{{email_field}}',
          subject: 'Following up',
          bodyParts: [
            { kind: 'text', text: 'Hi ' },
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: t('templates.bodyFallbacks.there') },
            { kind: 'text', text: ', just following up on your inquiry.' },
          ],
        },
      },
    },
    {
      // Mirrors the Feishu/Lark Base "When a record updates → Send a message"
      // pattern users coming from those tools expect to see in the gallery.
      // We only have send_email as an action today, so the trigger is the real
      // shift here — record_updated was not previously expressible in a template
      // draft. Card copy is honest about the email delivery to match the action.
      id: 'email-on-record-updated',
      name: t('templates.emailOnRecordUpdated.name'),
      description: t('templates.emailOnRecordUpdated.description'),
      icons: [{ kind: 'lucide', name: 'AlarmClock' }, { kind: 'lucide', name: 'Send' }],
      badgeCount: 1,
      draft: {
        name: t('templates.emailOnRecordUpdated.name'),
        description: '',
        trigger: { type: 'record_updated' },
        action: {
          type: 'send_email',
          to: '{{me}}',
          subject: 'Record updated',
          bodyParts: [
            { kind: 'text', text: 'A record was updated: ' },
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: t('templates.bodyFallbacks.unnamed') },
          ],
        },
      },
    },
    {
      // Mirrors the Feishu/Lark Base "At record's trigger time → Send a Feishu
      // message" template (green calendar + chat-bubble icons in the original).
      // Kition only has send_email as an action, so the card promises an email
      // reminder. The trigger type record_date_reached carries no date-field
      // reference at template-apply time — the user picks the column in the
      // trigger node's properties drawer (delayed binding), matching how table
      // selection works for the other templates.
      id: 'email-on-record-date',
      name: t('templates.emailOnRecordDate.name'),
      description: t('templates.emailOnRecordDate.description'),
      icons: [{ kind: 'lucide', name: 'CalendarClock' }, { kind: 'lucide', name: 'Send' }],
      badgeCount: 1,
      draft: {
        name: t('templates.emailOnRecordDate.name'),
        description: '',
        trigger: { type: 'record_date_reached' },
        action: {
          type: 'send_email',
          to: '{{me}}',
          subject: 'Reminder: a record date has arrived',
          bodyParts: [
            { kind: 'text', text: 'The trigger date arrived for: ' },
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: t('templates.bodyFallbacks.unnamed') },
          ],
        },
      },
    },
    {
      // Mirrors the Feishu/Lark Base "At scheduled time → Add a record"
      // template (clock + plus-square icons in the original). Cron is "0 11
      // * * *" — every day at 11:00 in the server's local timezone — chosen
      // so a user landing on the template can preview the picker as the
      // "Every day · 11:00" preset without further edits. Target table and
      // field assignments are intentionally empty: the user picks them in
      // the drawer's Add record panel after creation. Mirrors how
      // record_date_reached defers the date-field selection.
      id: 'add-record-daily-morning',
      name: t('templates.addRecordDailyMorning.name'),
      description: t('templates.addRecordDailyMorning.description'),
      icons: [{ kind: 'lucide', name: 'AlarmClock' }, { kind: 'lucide', name: 'Plus' }],
      badgeCount: 1,
      draft: {
        name: t('templates.addRecordDailyMorning.name'),
        description: '',
        trigger: { type: 'scheduled_time', schedule: { cron: '0 11 * * *' } },
        action: { type: 'add_record' },
      },
    },
  ]
}
