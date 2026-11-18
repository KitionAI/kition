/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/runtime-manifest.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type RuntimeManifestContract = {
  schemaVersion: 1
  runtimeVersion: string
  protocolVersion: number
  releaseTag: string
  assets: {
    [key: string]: {
      name: string
      sha256: string
      size: number
    }
  }
}
