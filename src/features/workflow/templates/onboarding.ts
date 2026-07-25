import type { WorkflowTemplate } from './index'

const LEAD_EMAIL_TEMPLATE_ID = 'lead-submission-email'

const onboardingTemplates: WorkflowTemplate[] = [
  {
    id: LEAD_EMAIL_TEMPLATE_ID,
    name: 'Form Submission Email Notification to Sales',
    description: 'Automatically sends an email to the sales team when a new lead is added to the Leads table.',
    icons: [{ kind: 'lucide', name: 'FileText' }, { kind: 'lucide', name: 'Send' }],
    sourceTableNames: ['Leads'],
    draft: {
      name: 'Form Submission Email Notification to Sales',
      description: 'Automatically sends an email to the sales team when a new lead is added to the Leads table.',
      trigger: { type: 'record_created' },
      action: {
        type: 'send_email',
        to: 'sales@kition.ai',
        subject: 'New Lead Submission Notification',
        bodyParts: [
          { kind: 'text', text: 'A new lead has submitted the form. Here are the details:' },
          { kind: 'newline' },
          { kind: 'newline' },
          { kind: 'text', text: 'First Name:  ' },
          { kind: 'field_ref_by_name', fieldName: 'First Name', fallback: '' },
          { kind: 'newline' },
          { kind: 'text', text: 'Last Name:   ' },
          { kind: 'field_ref_by_name', fieldName: 'Last Name', fallback: '' },
          { kind: 'newline' },
          { kind: 'text', text: 'Work Email:  ' },
          { kind: 'field_ref_by_name', fieldName: 'Work Email', fallback: '' },
          { kind: 'newline' },
          { kind: 'text', text: 'Company Name:' },
          { kind: 'field_ref_by_name', fieldName: 'Company Name', fallback: '' },
          { kind: 'newline' },
          { kind: 'text', text: 'Job Title:   ' },
          { kind: 'field_ref_by_name', fieldName: 'Job Title', fallback: '' },
          { kind: 'newline' },
          { kind: 'newline' },
          { kind: 'text', text: 'Reason for Contact:' },
          { kind: 'newline' },
          { kind: 'field_ref_by_name', fieldName: 'Reason for Contact', fallback: '' },
          { kind: 'newline' },
          { kind: 'newline' },
          { kind: 'text', text: 'Additional Notes:' },
          { kind: 'newline' },
          { kind: 'field_ref_by_name', fieldName: 'Additional Notes', fallback: '' },
        ],
      },
    },
  },
]

export function getOnboardingWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return onboardingTemplates.find((template) => template.id === id)
}
