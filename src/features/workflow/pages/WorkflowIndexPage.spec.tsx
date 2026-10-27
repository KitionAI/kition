import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listWorkflowRuns, listWorkflows } from '@/api/workflows'
import { useWorkflowLauncherState } from '@/features/workflow/hooks/useWorkflowLauncherState'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { ensureOnboardingWorkflow } from '@/features/workflow/lib/ensureOnboardingWorkflow'
import { WorkflowIndexPage } from './WorkflowIndexPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/api/workflows', () => ({
  WORKFLOW_CHANGED_EVENT: 'kition:workflow:changed',
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
}))
vi.mock('@/features/workflow/hooks/useWorkflowLauncherState', () => ({
  useWorkflowLauncherState: vi.fn(),
}))
vi.mock('@/features/workflow/hooks/useWorkflowTableLabels', () => ({
  useWorkflowTableLabels: vi.fn(),
}))
vi.mock('@/features/workflow/lib/ensureOnboardingWorkflow', () => ({
  ensureOnboardingWorkflow: vi.fn(),
}))
vi.mock('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog', () => ({
  WorkspaceWorkflowCreateModeDialog: () => null,
}))
let container: HTMLDivElement
let root: Root | null = null

async function mount(scopedTablePath = 'Getting Started/Guides/Lead Automation/Lead Follow-up.ktable') {
  const onSelectWorkflow = vi.fn()
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WorkflowIndexPage, {
      scopedTablePath,
      rootPath: '/vault',
      onSelectWorkflow,
    }))
    await Promise.resolve()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSelectWorkflow
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listWorkflows).mockResolvedValue([])
  vi.mocked(listWorkflowRuns).mockResolvedValue([])
  vi.mocked(useWorkflowTableLabels).mockReturnValue({
    labels: {},
    status: 'done',
  })
  vi.mocked(useWorkflowLauncherState).mockReturnValue({
    busyAction: null,
    busyTemplateId: undefined,
    error: null,
    runTemplate: vi.fn(),
    runScratch: vi.fn(),
    clearError: vi.fn(),
    handleAgent: vi.fn(),
  })
  vi.mocked(ensureOnboardingWorkflow).mockResolvedValue({
    created: [{ id: 'wf_lead_email' } as never],
    existing: [],
  })
  sessionStorage.clear()
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
  sessionStorage.clear()
})

describe('WorkflowIndexPage onboarding workflow preparation', () => {
  it('materializes and opens the lead email workflow for its scoped table file', async () => {
    const onSelectWorkflow = await mount()

    expect(ensureOnboardingWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      tableFilePath: 'Getting Started/Guides/Lead Automation/Lead Follow-up.ktable',
      rootPath: '/vault',
      workflows: [],
    }))
    expect(onSelectWorkflow).toHaveBeenCalledWith('wf_lead_email')
  })

  it('shows the empty state for a table file without workflows', async () => {
    vi.mocked(ensureOnboardingWorkflow).mockResolvedValueOnce({ created: [], existing: [] })
    const onSelectWorkflow = await mount('Projects/Customer Requests.ktable')

    expect(container.querySelector('[data-testid="workflow-index-empty"]')).not.toBeNull()
    expect(onSelectWorkflow).not.toHaveBeenCalled()
  })
})
