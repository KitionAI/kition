/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-model-reconnect.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

/**
 * Privacy-safe retry progress emitted in model.reconnecting Agent events.
 */
export type AgentModelReconnectContract = {
  turn: number
  attempt: number
  max_retries: 5
  delay_ms: number
  reason: "tls_handshake_timeout" | "connection_timeout" | "connection_closed" | "connection_reset" | "dns_failure" | "network_error" | "request_timeout" | "rate_limited" | "server_unavailable"
}
