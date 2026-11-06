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

  it('resumes an approved web fetch as a fetch, not a shell command', () => {
    const approved = buildAgentShellApprovalFollowup('allow_once', 'web_fetch https://news.example/a', 'web_fetch')
    expect(approved).toContain('Fetch this URL again now with web_fetch: https://news.example/a')
    expect(approved).not.toContain('shell')
    const denied = buildAgentShellApprovalFollowup('deny', 'web_fetch https://evil.example/?d=1', 'web_fetch')
    expect(denied).toContain('Do not fetch this URL: https://evil.example/?d=1')
    expect(denied).not.toContain('shell')
  })

  it('resumes an approved article save or image download with its own tool', () => {
    const article = buildAgentShellApprovalFollowup('allow_once', 'web_article_save https://news.example/a', 'web_article_save')
    expect(article).toContain('Call web_article_save again now with this URL: https://news.example/a')
    expect(article).not.toContain('shell')
    const image = buildAgentShellApprovalFollowup('deny', 'save_image_asset https://evil.example/p.png', 'save_image_asset')
    expect(image).toContain('Do not fetch this URL: https://evil.example/p.png')
    expect(image).not.toContain('shell')
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
