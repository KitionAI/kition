/**
 * A local folder the Agent may read for analysis. Shared by the desktop
 * bridge (which asks the user to pick one) and the Agent API (which sends
 * it with a turn); see contracts/runtime/agent-local-sources.schema.json.
 */
export type AgentLocalSource = {
  id: string
  label: string
  root_path: string
  access: 'read'
}
