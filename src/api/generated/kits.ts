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

export type KitsCommandView = {
  id: string
  title: string
  description: string | null
  group: string
  mutates: boolean
  enabled: boolean
  /**
   * Menu path in the kit, for example ["Layer", "New"]; empty when the command is not in a menu.
   */
  menu: string[]
  shortcut: string | null
}

/**
 * GET /v1/kits/{kitId}/documents/{documentId}/commands[?query=]
 */
export type KitsCommandList = {
  commands: KitsCommandView[]
}

/**
 * PUT /v1/kits/files?path=: replaces a workspace file a kit edits with the raw request body (application/octet-stream, up to 2 GiB). In-page editors save through it.
 */
export type KitsWriteFileQuery = {
  path: KitsWorkspacePath
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
  id?: number
  name: string
  kind: string
  visible: boolean
  opacity?: number | null
  blend?: string | null
  selected?: boolean
  /**
   * Nesting inside groups; 0 at the top level.
   */
  depth?: number
}

/**
 * RGBA, each 0 to 1.
 */
export type KitsPhotoColor = number[]

export type KitsPhotoDetails = {
  width: number
  height: number
  mode: string
  depth: number
  layers: KitsPhotoLayer[]
  activeLayer?: number | null
  /**
   * The embedded editor's active tool, for example Brush.
   */
  tool?: string | null
  brushSize?: number | null
  /**
   * 1 is 100%.
   */
  zoom?: number | null
  foreground?: KitsPhotoColor | null
  background?: KitsPhotoColor | null
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
