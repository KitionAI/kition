import type { AgentShellApprovalDecision } from '@/api/agent'

/** The hidden message that resumes a paused turn after the user decided on its command. */
export function buildAgentShellApprovalFollowup(
  decision: AgentShellApprovalDecision,
  command: string,
) {
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
