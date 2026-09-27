/**
 * Public entry of the agent feature for other features. Import from here,
 * never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 * The workspace shell uses these to open browser tabs the Agent asked for
 * and to continue a turn once the page is available.
 */
export { buildAgentBrowserTabPayload, dispatchOpenWorkspaceBrowserTab } from './lib/agentBrowserTab'
export {
  buildBrowserAutoContinuePrompt,
  buildBrowserUnavailablePrompt,
  extractAgentWebTarget,
  MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS,
} from './lib/agentBrowserIntent'
export { preflightAgentBrowserContext } from './lib/agentBrowserPreflight'
export {
  extractAgentBrowserContinuationContext,
  findLatestBrowserContinuationRequest,
  readBrowserOpenRequest,
  type AgentBrowserOpenRequest,
} from './lib/agentBrowserContinuation'
export {
  buildActiveBrowserTabContext,
  buildAgentTurnContext,
  finalizeAgentTurnContext,
  mapBrowserPageContextToAgentBrowserContext,
  type AgentTurnContext,
} from './lib/agentTurnContext'
export { appendAgentLocalSource, extractAgentLocalPathReference } from './lib/agentLocalSources'
export { useWorkspaceAgent } from './hooks/useWorkspaceAgent'
