import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
}))
const dataDocumentMock = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('./api', () => ({
  getFormSyncWorkflow: apiMock.get,
  syncFormSyncWorkflow: apiMock.sync,
  updateFormSyncWorkflow: apiMock.update,
}))
vi.mock('@/api/dataDocuments', () => ({
  getDataDocument: dataDocumentMock.get,
}))

import { FormSyncWorkflowPage } from './FormSyncWorkflowPage'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  document.documentElement.lang = 'zh-CN'
  apiMock.get.mockResolvedValue({
    id: 'formsync_local_1',
    name: 'Reservations form',
    template_id: 'reservations-form',
    remote_source_id: '',
    public_url: '',
    published: false,
    fields: [{
      key: 'reservation_time',
      label: 'Reservation time',
      type: 'datetime',
      required: false,
    }],
    target: {
      document_id: '7',
      table_id: '11',
      field_mappings: [{
        source_key: 'reservation_time',
        target_field_title: 'Reservation time',
      }],
    },
    schedule: { enabled: true, interval_minutes: 5 },
    status: 'paused',
    synced_submissions: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  })
  dataDocumentMock.get.mockResolvedValue({
    id: 7,
    tables: [{
      id: 11,
      title: 'Reservations',
      fields: [{
        id: 21,
        title: 'Reservation time',
        name: 'reservation_time',
        type: 'datetime',
        readonly: false,
      }],
    }],
  })
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
  document.documentElement.lang = ''
  vi.clearAllMocks()
})

describe('FormSyncWorkflowPage', () => {
  it('uses an English datetime preview instead of the system-localized native control', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(FormSyncWorkflowPage, { workflowId: 'formsync_local_1' }))
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })

    expect(container.querySelector('input[type="datetime-local"]')).toBeNull()
    const preview = container.querySelector('input[placeholder="YYYY-MM-DD HH:MM"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('type')).toBe('text')
    const previewCard = container.querySelector('[data-testid="form-sync-preview-card"]')
    expect(previewCard?.className).toContain('bg-background')
    expect(previewCard?.className).not.toContain('bg-white')
    const topbar = container.querySelector('[data-testid="form-sync-workflow-topbar"]')
    expect(topbar).not.toBeNull()
    expect(topbar?.textContent).toContain('Form builder')
    expect(topbar?.textContent).toContain('Publish')
    expect(topbar?.textContent).toContain('Save changes')
  })
})
