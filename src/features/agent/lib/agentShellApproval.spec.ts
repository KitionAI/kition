import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { expectMatchesContract } from '@/test/contracts'
import approvalTurns from './__fixtures__/approvalTurns.json'
import { buildAgentShellApprovalFollowup } from './agentShellApproval'
import { applySessionEvent, emptyAgentSessionView, pendingApprovalOf } from './agentSessionView'

const events = approvalTurns as AgentSessionEventsSessionEvent[]

describe('agent shell approval contract', () => {
  it('reads the paused command from the logged result meta', () => {
    const asked = events.slice(0, 11).reduce(applySessionEvent, emptyAgentSessionView())
    const pending = pendingApprovalOf(asked)
    expect(pending?.callId).toBe('call_1')
    expectMatchesContract(pending?.request, 'agent-shell-approval', 'request')
    expectMatchesContract({ call_id: pending?.callId, decision: 'allow_always' }, 'agent-shell-approval', 'response')
    expect(() => expectMatchesContract({ tool_call_id: 21, decision: 'allow_once' }, 'agent-shell-approval', 'response'))
      .toThrow()
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
