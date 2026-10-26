// Copied from kition-sdk packages/kit-engine/src/contract.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Engine contract 2 as TypeScript (Kit Harness Protocol (KHP) spec/kits/engine.md, architecture 7.2): the document
 * class a kit's engine worker drives. A WebAssembly engine made with `export_kit_document!` and
 * `export_kit_session!` has exactly these members, so one worker (`@kition/kit-editor`), the embed
 * SDK, and the object model serve both runtimes.
 */

/** One command as `commands()` lists it (KHP spec/reference/contract.md). */
export type KitEngineCommand = {
  id: string
  title: string
  description?: string | null
  /** The menu path, for example `["Page", "New"]`; `null` or empty when it is in no menu. */
  menu: string[] | null
  /** As `Cmd+Shift+N`. */
  shortcut: string | null
  mutates: boolean
  enabled: boolean
  /** The parameters as a JSON schema (`ParameterSchemaSpec`); commands with one can be agent tools. */
  schema?: Record<string, unknown> | null
  /** What the command answers, as one `ValueSchemaSpec` (KHP A1 `output.schema`); optional. */
  outputSchema?: Record<string, unknown> | null
  /** Parameter notes for an agent. */
  params?: string | null
}

/** What a change made stale on screen, as `importChanges` and `undo` answer it (Rust `Damage`). */
export type KitDamage = { kind: 'none' } | { kind: 'full' } | { kind: 'rects'; rects: Array<[number, number, number, number]> }

/** One open document. Every member is synchronous: the worker runs one request at a time. */
export interface KitEngineDocument {
  readonly width: number
  readonly height: number
  /** Moves with every change. */
  readonly revision: bigint
  /** Whether the document changed since the bytes `markSaved` confirmed. */
  readonly dirty: boolean
  /** RGBA8 pixels; an engine whose editor draws itself answers transparent pixels. */
  render(x: number, y: number, scale: number, width: number, height: number): Uint8Array
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Uint8Array
  /** Runs a command as the host's person, JSON in and out. */
  execute(command: string, params: string): string
  /** The document as JSON; it includes `canUndo` and `canRedo`. */
  inspect(): string
  /** Every command as JSON (`KitEngineCommand[]`). */
  commands(): string
  /** The ids of the commands that cannot run now, as JSON. */
  disabledCommands(): string
  /** The document's diagnostics as JSON `{ diagnostics: KitEngineDiagnostic[] }` (KHP 2.0 A21); optional. */
  check?(): string
  /** The document as file bytes; it stays unsaved until `markSaved`. */
  save(name?: string): Uint8Array
  markSaved(): void
  free(): void
  // Contract 2: the document as a replica of the Kit Data Model.
  /** The replica's own id (a sync room's `docId`). */
  readonly docId: string
  /** The replica's version, encoded. */
  version(): Uint8Array
  /** The changes since `since` (empty bytes: all of them). */
  exportChanges(since: Uint8Array): Uint8Array
  /** Imports another replica's changes; answers the damage as JSON. */
  importChanges(changes: Uint8Array): string
  snapshot(): Uint8Array
  /** `{"done", "damage"}` as JSON. */
  undo(): string
  redo(): string
  canUndo(): boolean
  canRedo(): boolean
  /** Runs a command as `origin`, the KDM's commit form `[kind, principal, label]` as JSON. */
  executeAs(command: string, params: string, origin: string): string
  /** The schema version the replica reads (its kit's `model.schemaVersion`); optional. */
  schemaVersion?(): number
  /**
   * The newest schema version any of the replica's changes was written under (standard 2.0 rule
   * M5a), or `null` when none records one; optional. Above `schemaVersion()`, a newer kit edited
   * the document, and the host tells the person (Kit UI protocol `document/schema`).
   */
  authorSchemaVersion?(): number | null
  /**
   * The blobs the replica's changes refer to, as a bundle for `addBlobs`; a host sends them with
   * every exchange of changes. Empty for a document without media.
   */
  blobs(): Uint8Array
  addBlobs(blobs: Uint8Array): void
}

/** The document class a module exports under the manifest's `engine.class`. */
export interface KitEngineClass {
  /** 1: hosts built for contract 1 open it; the manifest and the session members make it contract 2. */
  contractVersion(): number
  open(name: string, bytes: Uint8Array): KitEngineDocument
  /** Opens a file with the replica stored for it; a file that holds its replica may ignore them. */
  openWithReplica(name: string, bytes: Uint8Array, snapshot: Uint8Array, blobs: Uint8Array): KitEngineDocument
  create(name: string, width: number, height: number): KitEngineDocument
}

/**
 * What a `ts-worker` module's default export receives before its first document (rule K11): where
 * the module was loaded from, and, where `fetch` cannot read files (Node), how to read one of the
 * package's files by its path relative to `base`.
 */
export type KitEngineInit = {
  base: string
  read?: (file: string) => Promise<Uint8Array>
}

/** The module's default export: prepares the engine (for example, loads its dependencies' WebAssembly). */
export type KitEngineModuleInit = (init: KitEngineInit) => Promise<void>

/** One thing an engine found wrong with its document (KHP 2.0 A21): a stable `<kit>.<name>` code, what it is about (none set: the whole document; pages and slides count from 1), and a command hint to fix it. */
export type KitEngineDiagnostic = {
  code: string
  severity: 'error' | 'warning' | 'info'
  target: { objectId?: string; path?: string; page?: number; slide?: number; sheet?: string; cell?: string }
  message: string
  fix?: { command: string; params?: Record<string, unknown> }
}
