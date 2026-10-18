// Copied from kition-sdk packages/extensions/src/protocol.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The methods between the host and an extension's worker (`KitExtensions 1.0`). The host starts
 * the extension, activates it per document, and runs its commands; the worker reads and edits the
 * documents it is active on through the host, which checks every call against its permissions.
 */
import type { BatchRequest, BatchResult } from '../kdm'
import type { KitCommandInfo } from '../sdk'
import type { ExtensionManifest } from './manifest'

/** The message the host posts to the sandbox page with the channel's port (see `sandbox/`). */
export const SANDBOX_TAG = 'kition-ext-sandbox/1'
export type SandboxStart = { tag: typeof SANDBOX_TAG; type: 'start'; runtime: string; connect: string }

export type DocumentInfo = {
  documentId: string
  kitId: string
  /** The document's file name in the host (no folders), when it has one. */
  name?: string
  /** The kit's KDM schema: the proxies need it. */
  schema: object
  /** Whether writes are refused: the document is read-only, or the extension may not write. */
  readOnly: boolean
}

/** Host to worker. */
export type HostToWorker = {
  /** Loads the extension's module (`kind: script` for a script run once). */
  'extension/start': { params: { manifest: ExtensionManifest; source: string; kind?: 'extension' | 'script' }; result: null }
  /** Calls `activate(ctx)` for one document; answers the commands it registered. */
  'extension/activate': { params: DocumentInfo; result: { commands: string[] } }
  'extension/command': { params: { documentId: string; command: string }; result: unknown }
  'extension/deactivate': { params: { documentId: string }; result: null }
  /** A script's default export, run once against the document. */
  'script/run': { params: DocumentInfo; result: unknown }
  /** Notification: the document changed (`local`: the extension's own batch). */
  'document/changed': { params: { documentId: string; origin: 'local' | 'kit' }; result: never }
}

/** Worker to host. */
export type WorkerToHost = {
  'model/batch': { params: { documentId: string; request: BatchRequest }; result: BatchResult }
  'model/describe': { params: { documentId: string }; result: Record<string, unknown> }
  'model/commands': { params: { documentId: string }; result: KitCommandInfo[] }
  'commands/register': { params: { documentId: string; command: string }; result: null }
  /** Notification: a message for the person. */
  'host/notify': { params: Notice; result: never }
}

export type Notice = { level: 'info' | 'success' | 'warning' | 'error'; title: string; description?: string }
