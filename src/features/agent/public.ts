/**
 * Public entry of the agent feature for other features. Import from here,
 * never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export {
  buildAgentTurnContext,
  type AgentTurnContext,
} from './lib/agentTurnContext'
export { appendAgentLocalSource, extractAgentLocalPathReference } from './lib/agentLocalSources'
export { useWorkspaceAgent } from './hooks/useWorkspaceAgent'
export { emptyAgentSessionView, type AgentSessionView } from './lib/agentSessionView'
export { AgentFloatingLauncher } from './components/AgentFloatingLauncher'
