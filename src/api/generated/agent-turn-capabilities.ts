/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-turn-capabilities.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentTurnCapabilitiesToolAvailability = {
  available: boolean
  reason: string
}

export type AgentTurnCapabilitiesContract = {
  available_tools: string[]
  hosted_web_search: AgentTurnCapabilitiesToolAvailability
  browser_search: AgentTurnCapabilitiesToolAvailability
}
