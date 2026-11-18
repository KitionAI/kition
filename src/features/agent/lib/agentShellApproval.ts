import type { AgentShellApprovalDecision, AgentShellApprovalRequest } from '@/api/agent'

/** The URL a paused request's command (`<tool> <url>`) names. */
export function approvalUrl(command: string, action: NonNullable<AgentShellApprovalRequest['action']>) {
  const prefix = `${action} `
  return command.startsWith(prefix) ? command.slice(prefix.length) : command
}

/** The hidden message that resumes a paused turn after the user decided on its command or URL request. */
export function buildAgentShellApprovalFollowup(
  decision: AgentShellApprovalDecision,
  command: string,
  action?: AgentShellApprovalRequest['action'],
) {
  if (action) {
    const url = approvalUrl(command, action)
    if (decision === 'deny') {
      return [
        `The user denied the pending ${action} request.`,
        `Do not fetch this URL: ${url}`,
        'Continue the original task without it when possible; otherwise explain the exact blocker.',
      ].join('\n')
    }
    return [
      `The user approved the pending ${action} request.`,
      action === 'web_fetch'
        ? `Fetch this URL again now with web_fetch: ${url}`
        : `Call ${action} again now with this URL: ${url}`,
      'Continue the original task after it succeeds. A request to a site the user has not named may ask again.',
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
