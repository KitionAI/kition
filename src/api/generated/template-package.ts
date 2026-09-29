/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/template-package.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type TemplatePackageResource = {
  id: string
  kind: "table" | "view" | "dashboard" | "app" | "automation" | "attachment" | "design"
  title: string
  parentId?: string
  sourceId?: string
  /**
   * Editable slots a design resource exposes. Present only for the design kind.
   */
  slots?: TemplatePackageDesignSlot[]
  /**
   * Brand kit values a design resource binds when a brand is applied. Present only for the design kind.
   */
  brandBindings?: TemplatePackageBrandBinding[]
}

export type TemplatePackageDesignSlot = "headline" | "body" | "label" | "image" | "logo" | "accent"

export type TemplatePackageBrandBinding = "primary" | "accent" | "text" | "surface" | "font"

export type TemplatePackageContract = {
  id: string
  snapshotVersion: number
  title: string
  description: string
  includeData: boolean
  defaultResourceId: string
  resources: TemplatePackageResource[]
}
