import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceTabStripProps, workspaceTabReference, type WorkspaceTabStripActionsInput } from './workspaceTabStripActions'

const tabs: WorkspaceTab[] = [
  { id: 'doc-a', type: 'file-viewer', title: 'A', path: 'a.md', format: 'markdown' },
  { id: 'doc-b', type: 'file-viewer', title: 'B', path: 'b.kdesign', format: 'design' },
  { id: 'viewer', type: 'file-viewer', title: 'Photo', path: 'photo.png', format: 'image' },
  { id: 'flow', type: 'workflow', title: 'Flows' },
  { id: 'sites', type: 'gallery', title: 'Images', kind: 'images' },
]

function build(overrides: Partial<WorkspaceTabStripActionsInput> = {}) {
  const closeTab = vi.fn()
  const onCloseWorkflow = vi.fn()
  const activateTab = vi.fn()
  const props = buildWorkspaceTabStripProps({
    tabs,
    activeTabId: 'doc-a',
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
    expect(run.closed()).toEqual(['doc-a', 'doc-b', 'viewer', 'sites'])
  })

  it('closes every tab on close unmodified: a kit asks before it closes with unsaved edits', () => {
    const run = build()
    run.props.onCloseUnmodified!()
    expect(run.closed()).toEqual(['doc-a', 'doc-b', 'viewer', 'flow', 'sites'])
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

  it('references a tab by path or title', () => {
    expect(workspaceTabReference(tabs[0])).toBe('a.md')
    expect(workspaceTabReference(tabs[3])).toBe('Flows')
  })
})
