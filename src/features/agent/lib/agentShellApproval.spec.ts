import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@/api/agent'
import {
  buildAgentShellApprovalFollowup,
  readLatestAgentShellApprovalRequest,
} from '@/features/agent/lib/agentShellApproval'

const createdAt = '2026-08-19T12:00:00.000Z'

function message(id: number, role: AgentMessage['role'] = 'user'): AgentMessage {
  return {
    id,
    session_id: 1,
    user_id: 1,
    role,
    content: role === 'user' ? 'Push the changes' : 'Done',
    status: 'completed',
    created_at: createdAt,
  }
}

function approvalToolCall(): AgentToolCall {
  return {
    id: 21,
    session_id: 1,
    message_id: 10,
    user_id: 1,
    tool_name: 'exec_command',
    input_data: { cmd: ['git', 'push'] },
    output_data: {
      tool_call_id: 21,
      command: 'git push',
      reason: 'Command not covered by any rule; user approval required.',
      requires: 'approval',
      decision: 'prompt',
      suggested: { prefix: ['git'], decision: 'allow' },
    },
    status: 'completed',
    created_at: createdAt,
    updated_at: createdAt,
  }
}

describe('agent shell approval contract', () => {
  it('keeps the public schema strict and resumable', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-shell-approval.schema.json'),
      'utf8',
    ))
    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-shell-approval.schema.json')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['tool_call_id', 'command', 'requires', 'decision'])
    expect(schema.properties.requires.const).toBe('approval')
  })

  it('returns the latest unresolved command approval', () => {
    expect(readLatestAgentShellApprovalRequest(
      [approvalToolCall()],
      [message(10)],
    )).toEqual({
      tool_call_id: 21,
      command: 'git push',
      reason: 'Command not covered by any rule; user approval required.',
      suggested: { prefix: ['git'], decision: 'allow' },
    })
  })

  it('hides an approval after a later Agent turn starts', () => {
    expect(readLatestAgentShellApprovalRequest(
      [approvalToolCall()],
      [message(10), message(11, 'assistant')],
    )).toBeNull()
  })

  it('builds explicit resume and denial instructions', () => {
    expect(buildAgentShellApprovalFollowup('allow_once', 'git push')).toContain(
      'Retry this exact command now: git push',
    )
    expect(buildAgentShellApprovalFollowup('deny', 'git push')).toContain(
      'Do not run this command: git push',
    )
  })
})
