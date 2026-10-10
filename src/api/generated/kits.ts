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
  /**
   * Extensions the kit can create new documents in.
   */
  creates: string[]
  installed: boolean
  /**
   * Kit tabs can show the kit's own editor here: the desktop app on a supported system.
   */
  embeddable: boolean
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

/**
 * Logical pixels relative to the top-left of the window's web content.
 */
export type KitsSurfaceRect = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * POST /v1/kits/surfaces: opens the file in the kit's own editor, kept over `rect`.
 */
export type KitsOpenSurfaceRequest = {
  path: KitsWorkspacePath
  rect: KitsSurfaceRect
  /**
   * @default true
   */
  visible?: boolean
}

export type KitsSurfaceView = {
  surfaceId: number
  document: KitsDocumentView
}

/**
 * PUT /v1/kits/surfaces/{surfaceId}. DELETE on the same path closes the editor.
 */
export type KitsUpdateSurfaceRequest = {
  rect?: KitsSurfaceRect
  visible?: boolean
}

/**
 * POST /v1/kits/documents/new: creates an `Untitled image` file in the folder and opens it.
 */
export type KitsCreateRequest = {
  /**
   * Workspace-relative folder; empty for the workspace root.
   */
  folder?: string
  /**
   * @default "psd"
   */
  extension?: string
  /**
   * @default 1920
   */
  width?: number
  /**
   * @default 1080
   */
  height?: number
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
