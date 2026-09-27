/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/runtime-info.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

import type { CapabilitiesContract } from './capabilities'

export type RuntimeInfoContract = {
  pid: number
  workspace_id: string
  runtime_version: string
  protocol_version: number
  build_commit: string
  capabilities: CapabilitiesContract
}
