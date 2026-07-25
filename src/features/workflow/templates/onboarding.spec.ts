import { describe, expect, it } from 'vitest'

import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import { getOnboardingWorkflowTemplate } from './onboarding'

const leadsSchema = {
  id: '1',
  name: 'Leads',
  fields: [
    { id: '1', name: 'First Name', type: 'text' },
    { id: '2', name: 'Last Name', type: 'text' },
    { id: '3', name: 'Work Email', type: 'url' },
    { id: '4', name: 'Company Name', type: 'text' },
    { id: '5', name: 'Company Size', type: 'single_select' },
    { id: '6', name: 'Job Title', type: 'text' },
    { id: '7', name: 'Reason for Contact', type: 'text' },
    { id: '8', name: 'Additional Notes', type: 'long_text' },
  ],
}

describe('onboarding workflow templates', () => {
  it('materializes the lead email workflow with resolved Leads field references', () => {
    const template = getOnboardingWorkflowTemplate('lead-submission-email')
    expect(template).toBeDefined()

    const application = createWorkflowFromTemplate(template!, {
      documentId: 'onboarding-leads',
      tableId: '1',
      tableName: 'Leads',
      schema: leadsSchema,
    })

    expect(application.unresolvedFieldNames).toEqual([])
    expect(application.input).toEqual(expect.objectContaining({
      name: 'Form Submission Email Notification to Sales',
      enabled: false,
      trigger: expect.objectContaining({
        type: 'record_created',
        documentId: 'onboarding-leads',
        tableId: '1',
      }),
      action: expect.objectContaining({
        type: 'send_email',
        connectionId: '',
        to: 'sales@kition.ai',
        subject: { parts: [{ kind: 'text', text: 'New Lead Submission Notification' }] },
      }),
    }))
    expect(application.input.action.body.parts.flatMap((part) => (
      part.kind === 'field_ref' ? [part.fieldRef.fieldId] : []
    ))).toEqual(['1', '2', '3', '4', '6', '7', '8'])
  })
})
