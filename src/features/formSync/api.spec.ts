// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/api/request', () => ({ default: requestMock }))

import {
  createFormSyncWorkflow,
  listFormSyncWorkflows,
  syncFormSyncWorkflow,
  updateFormSyncWorkflow,
  type CreateFormSyncWorkflowInput,
} from './api'

const input: CreateFormSyncWorkflowInput = {
  name: 'Private Event Inquiry',
  template_id: 'lumiere-restaurant',
  fields: [{ key: 'event', label: 'Event', type: 'text', required: true }],
  target: {
    document_id: '7',
    table_id: '11',
    field_mappings: [{ source_key: 'event', target_field_title: 'Event' }],
  },
  schedule: { enabled: true, interval_minutes: 5 },
}

describe('form sync api', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists workflows', async () => {
    requestMock.get.mockResolvedValue({ items: [{ id: 'form_1' }] })

    await expect(listFormSyncWorkflows()).resolves.toEqual([{ id: 'form_1' }])
    expect(requestMock.get).toHaveBeenCalledWith('/v1/form-sync/workflows')
  })

  it('creates a workflow', async () => {
    requestMock.post.mockResolvedValue({ id: 'form_1' })

    await createFormSyncWorkflow(input)

    expect(requestMock.post).toHaveBeenCalledWith('/v1/form-sync/workflows', input)
  })

  it('starts an incremental sync', async () => {
    requestMock.post.mockResolvedValue({ workflow_id: 'form_1', imported: 1 })

    await syncFormSyncWorkflow('form_1')

    expect(requestMock.post).toHaveBeenCalledWith('/v1/form-sync/workflows/form_1/sync', {})
  })

  it('updates a draft and emits a refresh event', async () => {
    const listener = vi.fn()
    window.addEventListener('kition:form-sync:changed', listener)
    requestMock.patch.mockResolvedValue({ id: 'form_1', name: 'Published form' })

    await updateFormSyncWorkflow('form_1', { name: 'Published form', published: true })

    expect(requestMock.patch).toHaveBeenCalledWith('/v1/form-sync/workflows/form_1', {
      name: 'Published form',
      published: true,
    })
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('kition:form-sync:changed', listener)
  })
})
