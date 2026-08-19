import type {
  AgentMessage,
  AgentShellApprovalDecision,
  AgentShellApprovalRequest,
  AgentToolCall,
} from '@/api/agent'

const SHELL_TOOL_NAMES = new Set(['exec_command', 'shell_exec'])

function hasLaterTurn(
  toolCall: AgentToolCall,
  toolCalls: AgentToolCall[],
  messages: AgentMessage[],
) {
  const messageId = Number(toolCall.message_id || 0)
  if (messageId > 0) {
    return messages.some((message) => message.id > messageId)
      || toolCalls.some((candidate) => Number(candidate.message_id || 0) > messageId)
  }

  const createdAt = Date.parse(toolCall.created_at)
  if (Number.isNaN(createdAt)) {
    return false
  }
  return messages.some((message) => Date.parse(message.created_at) > createdAt)
    || toolCalls.some((candidate) => Date.parse(candidate.created_at) > createdAt)
}

export function readLatestAgentShellApprovalRequest(
  toolCalls: AgentToolCall[],
  messages: AgentMessage[],
): AgentShellApprovalRequest | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index]
    if (!SHELL_TOOL_NAMES.has(toolCall.tool_name) || toolCall.status !== 'completed') {
      continue
    }
    const output = toolCall.output_data
    const command = typeof output?.command === 'string' ? output.command.trim() : ''
    if (output?.requires !== 'approval' || !command || hasLaterTurn(toolCall, toolCalls, messages)) {
      continue
    }
    const prefix = Array.isArray(output?.suggested?.prefix)
      ? output.suggested.prefix
          .map((token: unknown) => String(token || '').trim())
          .filter(Boolean)
      : []
    return {
      tool_call_id: Number(output?.tool_call_id || toolCall.id),
      command,
      reason: typeof output?.reason === 'string' ? output.reason.trim() : '',
      suggested: prefix.length
        ? { prefix, decision: 'allow' }
        : undefined,
    }
  }
  return null
}

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
