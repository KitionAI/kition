// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}))
const dataDocumentMock = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/api/request', () => ({ default: requestMock }))
vi.mock('@/api/dataDocuments', () => ({
  getDataDocument: dataDocumentMock.get,
  listDataDocuments: dataDocumentMock.list,
  updateDataDocument: dataDocumentMock.update,
}))

import {
  createFormSyncWorkflow,
  listFormSyncWorkflows,
  syncFormSyncWorkflow,
  updateFormSyncWorkflow,
  type CreateFormSyncWorkflowInput,
} from './api'
import {
  FORM_SYNC_WORKFLOWS_META_KEY,
  type LocalFormSyncWorkflow,
} from './localDrafts'

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

function workflow(overrides: Partial<LocalFormSyncWorkflow> = {}): LocalFormSyncWorkflow {
  return {
    id: 'formsync_1',
    name: input.name,
    template_id: input.template_id,
    remote_source_id: '',
    public_url: '',
    published: false,
    fields: input.fields,
    target: input.target,
    schedule: input.schedule,
    status: 'paused',
    synced_submissions: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('form sync api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataDocumentMock.list.mockResolvedValue({ items: [] })
    dataDocumentMock.get.mockResolvedValue({ id: 7, meta: { dashboards: [] } })
    dataDocumentMock.update.mockResolvedValue({ id: 7 })
  })

  it('lists remote workflows together with local document drafts', async () => {
    const local = workflow({ id: 'formsync_local_1', name: 'Local draft' })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    requestMock.get.mockResolvedValue({ items: [workflow()] })

    await expect(listFormSyncWorkflows()).resolves.toEqual([workflow(), local])
    expect(requestMock.get).toHaveBeenCalledWith('/v1/form-sync/workflows', {
      suppressErrorMessage: true,
    })
  })

  it('still lists local drafts when the runtime route is unavailable', async () => {
    const local = workflow({ id: 'formsync_local_1' })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    requestMock.get.mockRejectedValue(new Error('The requested resource was not found'))

    await expect(listFormSyncWorkflows()).resolves.toEqual([local])
  })

  it('creates an unpublished draft in document metadata without calling the runtime route', async () => {
    const created = await createFormSyncWorkflow({ ...input, published: false })

    expect(created.id).toMatch(/^formsync_local_/)
    expect(created.published).toBe(false)
    expect(requestMock.post).not.toHaveBeenCalled()
    expect(dataDocumentMock.update).toHaveBeenCalledWith(7, {
      meta: expect.objectContaining({
        dashboards: [],
        [FORM_SYNC_WORKFLOWS_META_KEY]: [expect.objectContaining({
          id: created.id,
          name: input.name,
        })],
      }),
    })
  })

  it('updates a local draft without calling the runtime route', async () => {
    const local = workflow({ id: 'formsync_local_1' })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    dataDocumentMock.get.mockResolvedValue({
      id: 7,
      meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] },
    })

    const updated = await updateFormSyncWorkflow(local.id, { name: 'Updated draft' })

    expect(updated.name).toBe('Updated draft')
    expect(requestMock.patch).not.toHaveBeenCalled()
    expect(requestMock.post).not.toHaveBeenCalled()
    expect(dataDocumentMock.update).toHaveBeenCalledWith(7, {
      meta: expect.objectContaining({
        [FORM_SYNC_WORKFLOWS_META_KEY]: [expect.objectContaining({
          id: local.id,
          name: 'Updated draft',
        })],
      }),
    })
  })

  it('publishes a local draft remotely while preserving its local navigation id', async () => {
    const local = workflow({ id: 'formsync_local_1' })
    const remote = workflow({
      id: 'formsync_remote_1',
      published: true,
      public_url: 'https://kition.ai/forms/form_1',
      status: 'active',
    })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    dataDocumentMock.get.mockResolvedValue({
      id: 7,
      meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] },
    })
    requestMock.post.mockResolvedValue(remote)

    const published = await updateFormSyncWorkflow(local.id, { published: true })

    expect(requestMock.post).toHaveBeenCalledWith('/v1/form-sync/workflows', {
      ...input,
      published: true,
    })
    expect(published).toEqual(expect.objectContaining({
      id: local.id,
      remote_workflow_id: remote.id,
      published: true,
      public_url: remote.public_url,
    }))
  })

  it('keeps the local draft and explains when the publish route is unavailable', async () => {
    const local = workflow({ id: 'formsync_local_1' })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    requestMock.post.mockRejectedValue(new Error('The requested resource was not found'))

    await expect(updateFormSyncWorkflow(local.id, { published: true })).rejects.toThrow(
      'Publishing forms requires a runtime with form sync support. Your local draft is safe.',
    )
    expect(dataDocumentMock.update).not.toHaveBeenCalled()
  })

  it('starts an incremental sync with the remote id behind a local alias', async () => {
    const local = workflow({
      id: 'formsync_local_1',
      remote_workflow_id: 'formsync_remote_1',
      published: true,
    })
    dataDocumentMock.list.mockResolvedValue({
      items: [{ id: 7, meta: { [FORM_SYNC_WORKFLOWS_META_KEY]: [local] } }],
    })
    requestMock.post.mockResolvedValue({ workflow_id: 'formsync_remote_1', imported: 1 })

    await syncFormSyncWorkflow(local.id)

    expect(requestMock.post).toHaveBeenCalledWith('/v1/form-sync/workflows/formsync_remote_1/sync', {})
  })

  it('updates a remote workflow directly when no local draft exists', async () => {
    requestMock.patch.mockResolvedValue(workflow({ name: 'Published form' }))

    await updateFormSyncWorkflow('formsync_1', { name: 'Published form', published: true })

    expect(requestMock.patch).toHaveBeenCalledWith('/v1/form-sync/workflows/formsync_1', {
      name: 'Published form',
      published: true,
    })
  })
})
