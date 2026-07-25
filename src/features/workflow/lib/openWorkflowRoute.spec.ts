import { describe, expect, it, vi } from 'vitest'

import { openWorkflowHome, openWorkflowRoute } from './openWorkflowRoute'

describe('workflow route helpers', () => {
  it('pushes the workflow route and dispatches popstate', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const listener = vi.fn()
    window.addEventListener('popstate', listener)

    openWorkflowRoute({ documentId: '42', tableId: '7', tableName: 'Leads' })

    const call = pushSpy.mock.calls.at(-1)!
    expect(call[0]).toMatchObject({
      workflowContext: { documentId: '42', tableId: '7', tableName: 'Leads' },
    })
    expect(call[2]).toBe('/workflow/new')
    expect(listener).toHaveBeenCalled()

    window.removeEventListener('popstate', listener)
    vi.restoreAllMocks()
  })

  it('pushes the workflow home without carrying a stale context', () => {
    window.history.replaceState({
      workflowContext: { documentId: 'old', tableId: 'old', tableName: 'Old' },
      keep: true,
    }, '', '/documents')
    const pushSpy = vi.spyOn(window.history, 'pushState')

    openWorkflowHome()

    const call = pushSpy.mock.calls.at(-1)!
    expect(call[0]).toMatchObject({ keep: true })
    expect((call[0] as { workflowContext?: unknown }).workflowContext).toBeUndefined()
    expect((call[0] as { selectedWorkflowId?: unknown }).selectedWorkflowId).toBeUndefined()
    expect(call[2]).toBe('/workflow')
    vi.restoreAllMocks()
  })

  it('writes selectedWorkflowId into history.state when an workflowId is provided', () => {
    // Used by the Build page's "Open in Workflows to edit" handoff so Home
    // can land directly on the right workflow instead of falling back to the
    // first item in the list.
    window.history.replaceState({ keep: true }, '', '/documents')
    const pushSpy = vi.spyOn(window.history, 'pushState')

    openWorkflowHome({ workflowId: 'auto_42' })

    const call = pushSpy.mock.calls.at(-1)!
    expect(call[0]).toMatchObject({ keep: true, selectedWorkflowId: 'auto_42' })
    expect(call[2]).toBe('/workflow')
    vi.restoreAllMocks()
  })

  it('replaces any stale selectedWorkflowId when called without an id', () => {
    // If the user re-enters home via the workspace button (no id), we must not
    // resurrect a stale pre-selection left behind from an earlier handoff.
    window.history.replaceState({ selectedWorkflowId: 'auto_old', keep: true }, '', '/documents')
    const pushSpy = vi.spyOn(window.history, 'pushState')

    openWorkflowHome()

    const call = pushSpy.mock.calls.at(-1)!
    expect((call[0] as { selectedWorkflowId?: unknown }).selectedWorkflowId).toBeUndefined()
    expect(call[0]).toMatchObject({ keep: true })
    vi.restoreAllMocks()
  })
})
