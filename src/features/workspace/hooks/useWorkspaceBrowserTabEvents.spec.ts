import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { resolveBrowserTabOpenRequest } from './useWorkspaceBrowserTabEvents'

const tabs: WorkspaceTab[] = [
  { id: 'doc', type: 'document', title: 'Notes', path: 'notes.md' },
  {
    id: 'browser:generic-web:example.com:document:leads.kitable',
    type: 'browser',
    title: 'Example',
    provider: 'generic-web',
    host: 'example.com',
    originTabId: 'document:leads.kitable',
    originDocumentPath: 'leads.kitable',
  },
]

describe('resolveBrowserTabOpenRequest', () => {
  it('ignores requests without a provider', () => {
    expect(resolveBrowserTabOpenRequest(undefined, tabs, {})).toBeNull()
    expect(resolveBrowserTabOpenRequest({ provider: '' as never }, tabs, {})).toBeNull()
  })

  it('reuses the matching open tab and applies the payload activation flags', () => {
    const request = resolveBrowserTabOpenRequest(
      { provider: 'generic-web', host: 'example.com', origin_document_path: 'leads.kitable', activate: false },
      tabs,
      {},
    )
    expect(request?.tab.id).toBe('browser:generic-web:example.com:document:leads.kitable')
    expect(request?.options).toEqual({ activate: false, insertAfterActive: true })
  })

  it('falls back to the last table target for the origin of a new tab', () => {
    const request = resolveBrowserTabOpenRequest(
      { provider: 'generic-web', host: 'other.com', url: 'https://other.com' },
      [tabs[0]],
      { documentPath: 'orders.kitable', tableId: 7, originLabel: 'Orders' },
    )
    expect(request?.tab).toMatchObject({
      type: 'browser',
      originTabId: 'document:orders.kitable',
      originDocumentPath: 'orders.kitable',
      originTableId: 7,
      originLabel: 'Orders',
    })
    expect(request?.tab.id).toBe('browser:generic-web:other.com:document:orders.kitable')
  })
})
