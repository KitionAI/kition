/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/template-package.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type TemplatePackageResource = {
  id: string
  kind: "table" | "view" | "dashboard" | "app" | "automation" | "attachment"
  title: string
  parentId?: string
  sourceId?: string
}

export type TemplatePackageContract = {
  id: string
  snapshotVersion: number
  title: string
  description: string
  includeData: boolean
  defaultResourceId: string
  resources: TemplatePackageResource[]
}
