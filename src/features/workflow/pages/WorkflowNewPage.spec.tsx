import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowNewPage } from './WorkflowNewPage'

vi.mock('@/services/desktopSettings', () => ({
  loadDesktopSettings: vi.fn(),
}))
vi.mock('@/api/dataDocuments', () => ({
  listDataDocuments: vi.fn().mockResolvedValue({ items: [] }),
}))

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    await Promise.resolve()
  })
  root = null
  container.remove()
  vi.restoreAllMocks()
})

describe('WorkflowNewPage', () => {
  it('renders the launcher (not the legacy textarea page)', async () => {
    await mount(createElement(WorkflowNewPage, { tableName: 'Leads', onSubmit: vi.fn() }))
    expect(container.querySelector('[data-testid="workflow-launcher"]')).not.toBeNull()
    expect(container.textContent).toMatch(/Automate any task with workflows/)
  })

  it('still exposes legacy workflow-new-page test-id for backward compat', async () => {
    await mount(createElement(WorkflowNewPage, { tableName: 'Leads', onSubmit: vi.fn() }))
    expect(container.querySelector('[data-testid="workflow-new-page"]')).not.toBeNull()
  })
})
