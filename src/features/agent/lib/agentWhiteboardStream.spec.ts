import { describe, expect, it } from 'vitest'

import { readAgentWhiteboardPatchFrame } from './agentWhiteboardStream'

const patch = {
  type: 'whiteboard.patch' as const,
  schema_version: 1 as const,
  summary: 'Create a node',
  operations: [{
    op: 'element.create' as const,
    element: {
      id: 'node-1',
      kind: 'mind_node' as const,
      bounds: { x: 10, y: 20, width: 140, height: 70 },
      text: 'Idea',
    },
  }],
}

describe('Agent Whiteboard stream frames', () => {
  it('reads direct provisional and final patch frames', () => {
    expect(readAgentWhiteboardPatchFrame({
      type: 'whiteboard_patch_provisional',
      provisional: true,
      whiteboard_patch: patch,
    })).toEqual({ patch, provisional: true })

    expect(readAgentWhiteboardPatchFrame({
      type: 'whiteboard_patch',
      whiteboard_patch: patch,
    })).toEqual({ patch, provisional: false })
  })

  it('reads patches wrapped in a persisted agent event', () => {
    expect(readAgentWhiteboardPatchFrame({
      type: 'agent_event',
      event: {
        id: 1,
        session_id: 2,
        user_id: 3,
        event_type: 'whiteboard.patch',
        status: 'running',
        data: { patch },
        created_at: new Date(0).toISOString(),
      },
    })).toEqual({ patch, provisional: true })
  })
})
