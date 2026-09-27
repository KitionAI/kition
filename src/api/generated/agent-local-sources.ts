/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-local-sources.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

/**
 * Turn-scoped read-only folders selected by the user as evidence for Agent tasks. The runtime may expose bounded path search, content search, line-range reads, project instructions, and read-only Git history for these sources. Local source contents are model-visible for the active run but must not be persisted in Agent timeline output.
 */
export type AgentLocalSourcesContract = Array<{
  id: string
  label: string
  /**
   * Environment-native absolute directory path selected by the user. It is turn-scoped and must not be persisted into portable workspace data.
   */
  root_path: string
  /**
   * Local analysis sources are evidence-only. All generated files remain targeted at the current Kition workspace.
   */
  access: "read"
}>
