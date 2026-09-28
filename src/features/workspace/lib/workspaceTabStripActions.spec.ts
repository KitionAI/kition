import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceTabStripProps, workspaceTabReference, type WorkspaceTabStripActionsInput } from './workspaceTabStripActions'

const tabs: WorkspaceTab[] = [
  { id: 'doc-a', type: 'document', title: 'A', path: 'a.md' },
  { id: 'doc-b', type: 'document', title: 'B', path: 'b.md' },
  { id: 'viewer', type: 'file-viewer', title: 'Photo', path: 'photo.png', format: 'markdown' },
  { id: 'flow', type: 'workflow', title: 'Flows' },
  { id: 'sites', type: 'browser-sites', title: 'Sites' },
]

function build(overrides: Partial<WorkspaceTabStripActionsInput> = {}) {
  const closeTab = vi.fn()
  const onCloseWorkflow = vi.fn()
  const activateTab = vi.fn()
  const props = buildWorkspaceTabStripProps({
    tabs,
    activeTabId: 'doc-a',
    activeDocumentPath: 'a.md',
    hasUnsavedChanges: false,
    getOpenedDocumentDraftEntry: (path) => (path === 'b.md' ? { content: 'draft' } : null),
    workflowOpen: false,
    closeTab,
    activateTab,
    onCloseWorkflow,
    sidebarCollapsed: false,
    onToggleSidebar: () => {},
    ...overrides,
  })
  const closed = () => closeTab.mock.calls.map(([id]) => id)
  return { props, closed, onCloseWorkflow, activateTab }
}

describe('buildWorkspaceTabStripProps', () => {
  it('closes the tabs each scope selects', () => {
    let run = build()
    run.props.onCloseLeft!('viewer')
    expect(run.closed()).toEqual(['doc-a', 'doc-b'])

    run = build()
    run.props.onCloseRight!('flow')
    expect(run.closed()).toEqual(['sites'])

    run = build()
    run.props.onCloseReadOnly!()
    expect(run.closed()).toEqual(['viewer', 'sites'])
  })

  it('keeps modified documents on close unmodified', () => {
    const run = build({ hasUnsavedChanges: true })
    run.props.onCloseUnmodified!()
    expect(run.closed()).toEqual(['viewer', 'flow', 'sites'])
    expect(run.props.isTabModified!(tabs[0])).toBe(true)
    expect(run.props.isTabModified!(tabs[1])).toBe(true)
    expect(run.props.isTabModified!(tabs[2])).toBe(false)
  })

  it('leaves the workflow route when the remaining tab is not a workflow', () => {
    let run = build({ workflowOpen: true })
    run.props.onCloseOthers!('doc-b')
    expect(run.closed()).toEqual(['doc-a', 'viewer', 'flow', 'sites'])
    expect(run.onCloseWorkflow).toHaveBeenCalledTimes(1)

    run = build({ workflowOpen: true })
    run.props.onCloseOthers!('flow')
    expect(run.onCloseWorkflow).not.toHaveBeenCalled()

    run = build({ workflowOpen: true })
    run.props.onActivate(tabs[0])
    expect(run.onCloseWorkflow).toHaveBeenCalledTimes(1)
    expect(run.activateTab).toHaveBeenCalledWith(tabs[0])
  })

  it('references a tab by path, URL, or title', () => {
    expect(workspaceTabReference(tabs[0])).toBe('a.md')
    expect(workspaceTabReference({ id: 'w', type: 'browser', title: 'Docs', provider: 'google', url: 'https://example.com' } as WorkspaceTab)).toBe('https://example.com')
    expect(workspaceTabReference(tabs[3])).toBe('Flows')
  })
})
