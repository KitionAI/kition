import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('./api', () => ({
  createFormSyncWorkflow: apiMock.create,
}))

import { setupTemplateFormSync, type FormSyncTemplateSetup } from './templateSetup'

const setup: FormSyncTemplateSetup = {
  type: 'form-sync',
  name: 'Private Event Inquiry',
  templateId: 'lumiere-restaurant',
  tableTitle: 'Private Events',
  fields: [{ key: 'event', label: 'Event', type: 'text', required: true }],
  fieldMappings: [{ sourceKey: 'event', targetFieldTitle: 'Event' }],
  defaults: [{ targetFieldTitle: 'Status', value: 'Inquiry' }],
  submissionIdFieldTitle: 'Submission ID',
  submittedAtFieldTitle: 'Submitted At',
  intervalMinutes: 5,
}

describe('setupTemplateFormSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.create.mockResolvedValue({ id: 'formsync_1', public_url: 'https://kition.ai/forms/form_1' })
  })

  it('binds the form to the named sibling table instead of the first table', async () => {
    await setupTemplateFormSync({
      documentId: 7,
      tableIdsByTitle: { Reservations: 11, 'Private Events': 12 },
      setup,
    })

    expect(apiMock.create).toHaveBeenCalledWith(expect.objectContaining({
      published: false,
      target: expect.objectContaining({ document_id: '7', table_id: '12' }),
    }))
  })

  it('fails clearly when the target table is absent', async () => {
    await expect(setupTemplateFormSync({
      documentId: 7,
      tableIdsByTitle: { Reservations: 11 },
      setup,
    })).rejects.toThrow('Form sync target table was not created: Private Events')
  })
})
