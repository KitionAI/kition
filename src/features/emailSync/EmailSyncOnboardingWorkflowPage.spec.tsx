import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmailSyncOnboardingWorkflowPage } from './EmailSyncOnboardingWorkflowPage'

vi.mock('./EmailSyncWorkflowEditor', () => ({
  EmailSyncWorkflowEditor: (props: {
    enableByDefault: boolean
    defaultIntervalMinutes: number
    tablePath: string
    runAfterSave?: string
  }) => (
    <div
      data-testid="mock-email-sync-workflow-editor"
      data-enabled={String(props.enableByDefault)}
      data-interval={String(props.defaultIntervalMinutes)}
      data-run-after-save={props.runAfterSave || ''}
    >
      {props.tablePath}
    </div>
  ),
}))

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
})

async function mount(runAfterSave?: 'full') {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(EmailSyncOnboardingWorkflowPage, {
      tablePath: 'Getting Started/Guides/Email Automation/Inbox.kitable',
      runAfterSave,
      onSaved: vi.fn(),
    }))
    await Promise.resolve()
  })
}

describe('EmailSyncOnboardingWorkflowPage', () => {
  it('ships the onboarding inbox with a scheduled email sync workflow', async () => {
    await mount()

    expect(container.querySelector('[data-testid="workflow-canvas"]')).not.toBeNull()
    expect(container.querySelector('[data-node-role="trigger"]')?.textContent).toContain('Scheduled trigger')
    expect(container.querySelector('[data-node-role="trigger"]')?.textContent).toContain('Every 15 minutes')
    expect(container.querySelector('[data-node-role="action"]')?.textContent).toContain('Sync email inbox')
    expect(container.querySelector('[data-node-role="action"]')?.textContent)
      .toContain('Connect an email account to activate this step.')
  })

  it('opens the action configuration with the onboarding schedule defaults', async () => {
    await mount('full')

    await act(async () => {
      container.querySelector<HTMLElement>('[data-node-role="action"]')?.click()
      await Promise.resolve()
    })

    const editor = container.querySelector('[data-testid="mock-email-sync-workflow-editor"]')
    expect(editor?.getAttribute('data-enabled')).toBe('true')
    expect(editor?.getAttribute('data-interval')).toBe('15')
    expect(editor?.getAttribute('data-run-after-save')).toBe('full')
    expect(editor?.textContent).toContain('Getting Started/Guides/Email Automation/Inbox.kitable')
  })
})
