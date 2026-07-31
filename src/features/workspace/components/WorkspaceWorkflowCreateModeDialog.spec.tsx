import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceWorkflowCreateModeDialog } from './WorkspaceWorkflowCreateModeDialog'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('WorkspaceWorkflowCreateModeDialog email sync template', () => {
  it('launches email sync from the shared template picker', async () => {
    const onSelectEmailSync = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceWorkflowCreateModeDialog, {
        open: true,
        onOpenChange: vi.fn(),
        context: null,
        onSelect: vi.fn(),
        emailSyncTablePath: 'Projects/Customer Requests.kitable',
        onSelectEmailSync,
      }))
      await Promise.resolve()
    })

    await act(async () => {
      (document.querySelector('[data-testid="create-mode-template"]') as HTMLButtonElement).click()
    })
    const template = document.querySelector('[data-testid="email-sync-workflow-template"]') as HTMLButtonElement
    expect(template.textContent).toContain('Full email inbox sync')
    expect(template.textContent).toContain('Import every message from the selected IMAP mailbox')

    await act(async () => template.click())
    expect(onSelectEmailSync).toHaveBeenCalledWith('Projects/Customer Requests.kitable', 'full')
  })
})
