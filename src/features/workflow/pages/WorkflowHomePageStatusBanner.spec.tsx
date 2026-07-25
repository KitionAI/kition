import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowDefinition } from '@/features/workflow/api'
import type { ValidationErrors, WorkflowDraft } from '@/features/workflow/lib/workflowDraft'
import { StatusBannerSlot } from './WorkflowHomePageStatusBanner'

let container: HTMLDivElement
let root: Root | null = null

const selected = {
  id: 'auto_lookup',
  name: 'Lookup',
  description: '',
  enabled: true,
  trigger: { nodeId: 'trigger_1', type: 'record_created_or_updated', documentId: '1', tableId: '2' },
  action: { nodeId: 'action_1', type: 'lookup_record', body: { parts: [] } },
} as WorkflowDefinition

const lookupDraft: WorkflowDraft = {
  name: 'Lookup',
  description: '',
  actionType: 'lookup_record',
  connectionId: '',
  to: '',
  subject: { parts: [] },
  body: { parts: [] },
  lookupRecord: { targetTableId: '', matchFieldId: '', matchValue: { parts: [] }, writeBack: [] },
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

async function render(draft: WorkflowDraft, validation: ValidationErrors = {}) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(StatusBannerSlot, {
      selected,
      draft,
      validation,
      latestRun: null,
      onFix: vi.fn(),
      onEnable: vi.fn(),
    }))
    await Promise.resolve()
  })
}

describe('WorkflowHomePageStatusBanner', () => {
  it('does not require an email connection for a valid lookup action', async () => {
    await render(lookupDraft)
    expect(container.querySelector('[data-banner-state="enabled"]')).toBeTruthy()
    expect(container.textContent).not.toContain('No connection selected')
  })

  it('shows the lookup configuration error and a generic action repair CTA', async () => {
    await render(lookupDraft, { recordAction: 'lookupRecordConfigRequired' })
    expect(container.textContent).toContain('Complete the lookup and add a write-back mapping')
    expect(container.textContent).toContain('Fix action')
    expect(container.textContent).not.toContain('Fix connection')
  })

  it('keeps the connection-specific CTA for email actions', async () => {
    await render({ ...lookupDraft, actionType: 'send_email' })
    expect(container.textContent).toContain('No connection selected')
    expect(container.textContent).toContain('Fix connection')
  })
})
