/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-shell-approval.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentShellApprovalRequest = {
  kind: "shell.approval"
  command: string
  reason: string
  requires: "approval"
  decision: "prompt"
  suggested?: AgentShellApprovalRule
  /**
   * Present for a web fetch, whose command is `web_fetch <url>`; absent for a shell command.
   */
  action?: "web_fetch"
}

export type AgentShellApprovalResponse = {
  call_id: string
  decision: AgentShellApprovalDecision
}

export type AgentShellApprovalDecision = "allow_once" | "allow_always" | "deny"

export type AgentShellApprovalRule = {
  prefix: string[]
  decision: "allow"
}

/**
 * A shell command, or a web fetch, that the agent's policy paused for the user's approval. The request is the presentation meta of the paused exec_command or web_fetch tool/result (followed by approval/asked and turn/end awaiting-approval in the session log); the response is the stream request's shell_approval, naming the paused call by its callId. A web fetch is approved once only: no suggested rule and no allow_always.
 */
export type AgentShellApprovalContract = AgentShellApprovalRequest
