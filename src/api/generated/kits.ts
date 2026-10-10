/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/kits.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type KitsKitId = string

export type KitsWorkspacePath = string

export type KitsKitStatus = {
  id: KitsKitId
  name: string
  extensions: string[]
  installed: boolean
  /**
   * Environment variable that points at a local build of the kit executable.
   */
  binaryEnv: string
}

export type KitsKitList = {
  kits: KitsKitStatus[]
}

export type KitsOpenRequest = {
  path: KitsWorkspacePath
}

export type KitsDocumentView = {
  kitId: KitsKitId
  documentId: string
  /**
   * Workspace-relative path; null until the document is saved.
   */
  path: KitsWorkspacePath | null
  title: string
  format: string
  readOnly: boolean
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /**
   * Increments whenever the kit reports a change, including agent edits.
   */
  version: number
  summary: string
  /**
   * Kit-defined structure from view.describe. kit.photo reports width, height, mode, depth, and layers.
   */
  details: Record<string, unknown>
}

export type KitsPhotoLayer = {
  name: string
  kind: string
  visible: boolean
}

export type KitsPhotoDetails = {
  width: number
  height: number
  mode: string
  depth: number
  layers: KitsPhotoLayer[]
}

export type KitsExecuteRequest = {
  command: string
  params?: Record<string, unknown>
}

export type KitsExecuteResult = {
  changed: boolean
  result: unknown
  document: KitsDocumentView
}

/**
 * GET /v1/kits, POST /v1/kits/documents, and /v1/kits/{kitId}/documents/{documentId}[/commands|/save|/preview]. JSON answers use the runtime envelope; /preview answers image/png. Errors carry data.reason: not_installed, stopped, or a Kit Protocol reason such as document_not_found.
 */
export type KitsContract = KitsKitList
