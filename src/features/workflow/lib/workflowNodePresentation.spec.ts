import { describe, expect, it, vi } from 'vitest'

import type { NodeIssue, WorkflowDefinition } from '@/api/workflows'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { emptyDraft } from '@/features/workflow/lib/workflowDraft'

import { deriveNodeStatus, issueMessageFor, resolveActionInlineError } from './workflowNodePresentation'

const selected = {
  id: 'wf', name: 'W', description: '', enabled: true,
  trigger: { nodeId: 'trigger_1', type: 'record_created', documentId: 'd', tableId: 't' },
  action: { nodeId: 'action_1', type: 'send_email', body: { parts: [] } },
} as unknown as WorkflowDefinition
const draft = { ...emptyDraft(), actionType: 'send_email', connectionId: 'c1', to: 'a@b.c', subject: { parts: [{ kind: 'text' as const, text: 's' }] }, body: { parts: [{ kind: 'text' as const, text: 'b' }] } }
const trigger: GraphNode = { nodeId: 'trigger_1', kind: 'trigger', config: {} }
const action: GraphNode = { nodeId: 'action_1', kind: 'action', config: {} }
const errorIssue: NodeIssue = { nodeId: 'action_1', code: 'x', message: 'Server says no', level: 'error' }
const warnIssue: NodeIssue = { nodeId: 'action_1', code: 'y', message: 'Server hint', hint: 'Do this', level: 'warning' }
const t = (key: string) => key

describe('deriveNodeStatus', () => {
  const base = { selected, draft, validation: {}, latestRun: null, issues: [], streamingPhase: null }

  it('follows the build phase while streaming, except for filters', () => {
    expect(deriveNodeStatus({ ...base, node: trigger, streamingPhase: 'trigger.generated' as never })).toBeDefined()
    const filter: GraphNode = { nodeId: 'f', kind: 'filter', config: { expression: '' } }
    expect(deriveNodeStatus({ ...base, node: filter, streamingPhase: 'trigger.generated' as never })).toBe(deriveNodeStatus({ ...base, node: filter }))
  })

  it('lets server errors force red and warnings lift to amber', () => {
    expect(deriveNodeStatus({ ...base, node: action })).toBe('green')
    expect(deriveNodeStatus({ ...base, node: action, issues: [errorIssue] })).toBe('red')
    expect(deriveNodeStatus({ ...base, node: action, issues: [warnIssue] })).toBe('amber')
    expect(deriveNodeStatus({ ...base, node: action, issues: [warnIssue], validation: { to: 'recipientRequired' } })).toBe('red')
  })
})

describe('resolveActionInlineError', () => {
  const onFix = vi.fn()
  const base = { draft, validation: {}, latestRun: null, enabled: true, issues: [], t, onFix }

  it('returns nothing for a healthy action and advisory text for a server warning', () => {
    expect(resolveActionInlineError(base)).toBeNull()
    expect(resolveActionInlineError({ ...base, issues: [warnIssue] })).toEqual({ message: 'Server hint', severity: 'warning' })
  })

  it('prefers server errors over local validation, except for a missing connection', () => {
    const server = resolveActionInlineError({ ...base, issues: [errorIssue], validation: { to: 'recipientRequired' } })
    expect(server).toMatchObject({ message: 'Server says no', severity: 'error', fixLabel: 'Fix' })
    const missing = resolveActionInlineError({ ...base, draft: { ...draft, connectionId: '' }, issues: [errorIssue] })
    expect(missing?.message).toBe('panels.home.validation.connectionRequired')
    expect(missing?.severity).toBe('error')
  })

  it('downgrades local issues to warnings while the workflow is off, unless the last run failed', () => {
    const off = resolveActionInlineError({ ...base, enabled: false, validation: { to: 'recipientRequired' } })
    expect(off?.severity).toBe('warning')
    const failed = resolveActionInlineError({ ...base, enabled: false, latestRun: { status: 'error', error: 'boom' } as WorkflowRunRecord })
    expect(failed).toMatchObject({ message: 'boom', severity: 'error' })
  })
})

describe('issueMessageFor', () => {
  it('returns the hint when present, else the message, for the first matching code', () => {
    expect(issueMessageFor([errorIssue, warnIssue], ['y'])).toBe('Do this')
    expect(issueMessageFor([errorIssue, warnIssue], ['x', 'y'])).toBe('Server says no')
    expect(issueMessageFor([errorIssue], ['z'])).toBeUndefined()
  })
})
