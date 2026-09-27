/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/errors.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type ErrorsContract = {
  code: "runtime_missing" | "runtime_download_failed" | "runtime_checksum_mismatch" | "runtime_archive_invalid" | "runtime_protocol_incompatible" | "runtime_platform_unsupported"
  message: string
  details?: Record<string, unknown>
}
