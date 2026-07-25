import { describe, expect, it } from 'vitest'

import {
  STREAMING_WORKFLOW_ID,
  eventsToPreviewWorkflow,
  eventsToProgressState,
  findCreatedWorkflowId,
  isAiBuildLocked,
  phaseLabelKey,
  statusForPhase,
  withStreamingId,
} from './aiBuildPreview'
import type { WorkflowBuildEvent } from '@/features/workflow/types'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'

const schema: TableSchema = { id: 'tbl_1', name: 'Customers', fields: [] }

describe('eventsToPreviewWorkflow', () => {
  it('returns null until workflow.generated arrives', () => {
    expect(eventsToPreviewWorkflow([], schema)).toBeNull()
  })

  it('synthesizes a minimal workflow from workflow.generated alone', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_1', name: 'My WF', description: 'd' },
    ]
    const wf = eventsToPreviewWorkflow(events, schema, 'doc_1')
    expect(wf).not.toBeNull()
    expect(wf!.id).toBe('wf_1')
    expect(wf!.name).toBe('My WF')
    expect(wf!.trigger.tableId).toBe('tbl_1')
    expect(wf!.trigger.documentId).toBe('doc_1')
    expect(wf!.action.type).toBe('send_email')
    // Should still produce both nodes + edge so the canvas renders skeletons.
    expect(wf!.nodes).toHaveLength(2)
    expect(wf!.edges).toHaveLength(1)
  })

  it('fills trigger config when trigger.generated arrives', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_1', name: 'My WF', description: 'd' },
      { kind: 'trigger.generated', nodeId: 't_real', triggerType: 'record_created', tableId: 'tbl_overridden', config: {} },
    ]
    const wf = eventsToPreviewWorkflow(events, schema, 'doc_1')
    expect(wf!.trigger.nodeId).toBe('t_real')
    expect(wf!.trigger.tableId).toBe('tbl_overridden')
    expect(wf!.trigger.type).toBe('record_created')
  })

  it('fills action config (string subject normalised to BodyTemplate)', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_1', name: 'My WF', description: 'd' },
      { kind: 'action.generated', nodeId: 'a_real', actionType: 'send_email', config: { to: 'a@b.com', subject: 'Hi' } },
    ]
    const wf = eventsToPreviewWorkflow(events, schema, 'doc_1')
    expect(wf!.action.nodeId).toBe('a_real')
    expect(wf!.action.to).toBe('a@b.com')
    expect(wf!.action.subject).toEqual({ parts: [{ kind: 'text', text: 'Hi' }] })
  })

  it('passes through BodyTemplate subject untouched', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_1', name: 'My WF', description: 'd' },
      { kind: 'action.generated', nodeId: 'a_real', actionType: 'send_email', config: { to: 'x', subject: { parts: [{ kind: 'text', text: 'kept' }] }, body: { parts: [] } } },
    ]
    const wf = eventsToPreviewWorkflow(events, schema, 'doc_1')
    expect(wf!.action.subject).toEqual({ parts: [{ kind: 'text', text: 'kept' }] })
  })

  it('handles missing tableSchema (ai-no-context flow)', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_1', name: 'My WF', description: 'd' },
    ]
    const wf = eventsToPreviewWorkflow(events, null)
    expect(wf!.trigger.tableId).toBe('')
    expect(wf!.trigger.documentId).toBeUndefined()
  })
})

describe('eventsToProgressState', () => {
  it('idle when status idle', () => {
    expect(eventsToProgressState([], 'idle')).toBe('idle')
  })
  it('submitting before any event', () => {
    expect(eventsToProgressState([], 'submitting')).toBe('submitting')
  })
  it('phases through stream events', () => {
    expect(eventsToProgressState([], 'streaming')).toBe('generating-workflow')
    expect(eventsToProgressState([
      { kind: 'workflow.generated', workflowId: 'w', name: 'n', description: 'd' },
    ], 'streaming')).toBe('generating-trigger')
    expect(eventsToProgressState([
      { kind: 'workflow.generated', workflowId: 'w', name: 'n', description: 'd' },
      { kind: 'trigger.generated', nodeId: 't', triggerType: 'record_created', tableId: 'tbl', config: {} },
    ], 'streaming')).toBe('generating-action')
    expect(eventsToProgressState([
      { kind: 'workflow.generated', workflowId: 'w', name: 'n', description: 'd' },
      { kind: 'trigger.generated', nodeId: 't', triggerType: 'record_created', tableId: 'tbl', config: {} },
      { kind: 'action.generated', nodeId: 'a', actionType: 'send_email', config: {} },
    ], 'streaming')).toBe('persisting')
  })
  it('done state takes priority', () => {
    expect(eventsToProgressState([
      { kind: 'workflow.created', workflowId: 'w' },
    ], 'done')).toBe('done')
  })
  it('error always maps to error phase', () => {
    expect(eventsToProgressState([], 'error')).toBe('error')
  })
})

describe('isAiBuildLocked', () => {
  it.each([
    ['idle', false],
    ['submitting', true],
    ['streaming', true],
    ['done', false],
    ['error', false],
  ] as const)('%s → %s', (status, expected) => {
    expect(isAiBuildLocked(status)).toBe(expected)
  })
})

describe('findCreatedWorkflowId', () => {
  it('returns null when no workflow.created event', () => {
    expect(findCreatedWorkflowId([])).toBeNull()
    expect(findCreatedWorkflowId([
      { kind: 'workflow.generated', workflowId: 'pre', name: 'n', description: 'd' },
    ])).toBeNull()
  })
  it('returns the persisted id once workflow.created arrives', () => {
    expect(findCreatedWorkflowId([
      { kind: 'workflow.created', workflowId: 'wf_real' },
    ])).toBe('wf_real')
  })
})

describe('withStreamingId / STREAMING_WORKFLOW_ID', () => {
  it('rewrites the id to the streaming sentinel without touching the rest', () => {
    const events: WorkflowBuildEvent[] = [
      { kind: 'workflow.generated', workflowId: 'wf_future', name: 'N', description: 'd' },
    ]
    const wf = eventsToPreviewWorkflow(events, schema, 'doc_1')!
    const streaming = withStreamingId(wf)
    expect(streaming.id).toBe(STREAMING_WORKFLOW_ID)
    expect(streaming.name).toBe('N')
    expect(streaming.trigger).toEqual(wf.trigger)
    // The original isn't mutated.
    expect(wf.id).toBe('wf_future')
  })
})

describe('phaseLabelKey', () => {
  it.each([
    ['idle', 'panels.build.streamWaiting'],
    ['submitting', 'panels.build.streamWaiting'],
    ['generating-workflow', 'panels.progress.stepWorkflow'],
    ['generating-trigger', 'panels.progress.stepTrigger'],
    ['generating-action', 'panels.progress.stepAction'],
    ['persisting', 'panels.build.streamGenerating'],
    ['done', 'panels.progress.title'],
    ['error', 'panels.build.streamGenerating'],
  ] as const)('%s → %s', (phase, key) => {
    expect(phaseLabelKey(phase)).toBe(key)
  })
})

describe('statusForPhase', () => {
  it('error → red for both roles', () => {
    expect(statusForPhase('error', 'trigger')).toBe('red')
    expect(statusForPhase('error', 'action')).toBe('red')
  })
  it('trigger lights up green once any phase past generating-workflow is reached', () => {
    expect(statusForPhase('generating-workflow', 'trigger')).toBe('muted')
    expect(statusForPhase('generating-trigger', 'trigger')).toBe('green')
    expect(statusForPhase('generating-action', 'trigger')).toBe('green')
    expect(statusForPhase('done', 'trigger')).toBe('green')
  })
  it('action goes muted → amber → green as the action phase progresses', () => {
    expect(statusForPhase('generating-trigger', 'action')).toBe('muted')
    expect(statusForPhase('generating-action', 'action')).toBe('amber')
    expect(statusForPhase('persisting', 'action')).toBe('green')
    expect(statusForPhase('done', 'action')).toBe('green')
  })
})
