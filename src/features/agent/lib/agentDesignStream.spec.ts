import { describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '@/api/agent'
import { readAgentDesignPatchFrame } from './agentDesignStream'

const patch = {
  type: 'design.patch' as const,
  schema_version: 1 as const,
  summary: 'Rewrite the headline',
  operations: [{ op: 'text.set' as const, layer_id: 'headline', text: 'Launch night' }],
}

describe('readAgentDesignPatchFrame', () => {
  it('reads top-level provisional and final frames with their design path', () => {
    const provisional = readAgentDesignPatchFrame({
      type: 'design_patch_provisional',
      provisional: true,
      design_path: 'posters/launch.kidesign',
      design_patch: patch,
    } as AgentStreamEvent)
    expect(provisional).toEqual({ designPath: 'posters/launch.kidesign', patch, provisional: true })
    const final = readAgentDesignPatchFrame({ type: 'design_patch', design_patch: patch } as AgentStreamEvent)
    expect(final).toEqual({ designPath: '', patch, provisional: false })
  })

  it('reads the completed tool output and streaming tool arguments', () => {
    const completed = readAgentDesignPatchFrame({
      type: 'tool_call',
      tool_call: {
        tool_name: 'design_propose_patch',
        status: 'completed',
        output_data: JSON.stringify({ design_path: 'a.kidesign', design_patch: JSON.stringify(patch) }),
      },
    } as unknown as AgentStreamEvent)
    expect(completed).toEqual({ designPath: 'a.kidesign', patch, provisional: false })
    const streaming = readAgentDesignPatchFrame({
      type: 'model_tool_call_ready',
      extra_data: { tool_name: 'design_propose_patch', arguments: JSON.stringify(patch) },
    } as unknown as AgentStreamEvent)
    expect(streaming?.provisional).toBe(true)
    expect(streaming?.patch).toEqual(patch)
  })

  it('ignores whiteboard patches and unrelated events', () => {
    expect(readAgentDesignPatchFrame({ type: 'delta', content: 'hi' } as AgentStreamEvent)).toBeNull()
    expect(
      readAgentDesignPatchFrame({
        type: 'whiteboard_patch',
        whiteboard_patch: { ...patch, type: 'whiteboard.patch' },
      } as unknown as AgentStreamEvent),
    ).toBeNull()
  })
})
