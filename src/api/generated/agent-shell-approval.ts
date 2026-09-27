/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-shell-approval.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentShellApprovalRule = {
  prefix: string[]
  decision: "allow"
}

/**
 * A resumable approval contract for an Agent shell command that was blocked by the execution policy.
 */
export type AgentShellApprovalContract = {
  tool_call_id: number
  command: string
  reason?: string
  requires: "approval"
  decision: "prompt"
  suggested?: AgentShellApprovalRule
}
