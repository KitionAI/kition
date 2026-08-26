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
    })).toEqual({ boardPath: '', patch, provisional: true })

    expect(readAgentWhiteboardPatchFrame({
      type: 'whiteboard_patch',
      board_path: 'Boards/Planning.kiboard',
      whiteboard_patch: patch,
    })).toEqual({ boardPath: 'Boards/Planning.kiboard', patch, provisional: false })
  })

  it('reads the nested legacy runtime frame while preferring its board path', () => {
    expect(readAgentWhiteboardPatchFrame({
      type: 'whiteboard_patch',
      extra_data: {
        board_path: 'Boards/Nested.kiboard',
        whiteboard_patch: patch,
      },
    })).toEqual({
      boardPath: 'Boards/Nested.kiboard',
      patch,
      provisional: false,
    })
  })

  it('reads a provisional patch from completed model tool arguments', () => {
    expect(readAgentWhiteboardPatchFrame({
      type: 'model_tool_call_ready',
      extra_data: {
        tool_name: 'whiteboard_propose_patch',
        arguments: JSON.stringify(patch),
      },
    })).toEqual({
      boardPath: '',
      patch,
      provisional: true,
    })
  })

  it.each([
    {
      label: 'object output data',
      outputData: {
        board_path: 'Untitled board 5.kiboard',
        whiteboard_patch: patch,
      },
    },
    {
      label: 'serialized output data',
      outputData: JSON.stringify({
        board_path: 'Untitled board 5.kiboard',
        whiteboard_patch: patch,
      }),
    },
  ])('reads a final patch from completed tool call $label', ({ outputData }) => {
    expect(readAgentWhiteboardPatchFrame({
      type: 'tool_call',
      tool_call: {
        id: 100,
        session_id: 24,
        user_id: 1,
        tool_name: 'whiteboard_propose_patch',
        status: 'completed',
        output_data: outputData,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      },
    })).toEqual({
      boardPath: 'Untitled board 5.kiboard',
      patch,
      provisional: false,
    })
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
    })).toEqual({ boardPath: '', patch, provisional: true })
  })
})
