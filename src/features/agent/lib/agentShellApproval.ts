import type { AgentShellApprovalDecision, AgentShellApprovalRequest } from '@/api/agent'

const FETCH_PREFIX = 'web_fetch '

/** The hidden message that resumes a paused turn after the user decided on its command or fetch. */
export function buildAgentShellApprovalFollowup(
  decision: AgentShellApprovalDecision,
  command: string,
  action?: AgentShellApprovalRequest['action'],
) {
  if (action === 'web_fetch') {
    const url = command.startsWith(FETCH_PREFIX) ? command.slice(FETCH_PREFIX.length) : command
    if (decision === 'deny') {
      return [
        'The user denied the pending web fetch.',
        `Do not fetch this URL: ${url}`,
        'Continue the original task without it when possible; otherwise explain the exact blocker.',
      ].join('\n')
    }
    return [
      'The user approved the pending web fetch.',
      `Fetch this URL again now with web_fetch: ${url}`,
      'Continue the original task after it succeeds. A fetch of a site the user has not named may ask again.',
    ].join('\n')
  }
  if (decision === 'deny') {
    return [
      'The user denied the pending shell command.',
      `Do not run this command: ${command}`,
      'Continue the original task without it when possible; otherwise explain the exact blocker.',
    ].join('\n')
  }
  return [
    'The user approved the pending shell command.',
    `Retry this exact command now: ${command}`,
    'Continue the original task after it succeeds. Request approval again before running a different command that is not already allowed.',
  ].join('\n')
}
