// Copied from kition-sdk packages/sdk/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `@kition/sdk`: the Kition object model (`KitObjectModel 1.0`). Open a document from an
 * `@kition/embed` editor, a `KitConnection`, or a kit engine; queue reads and writes on typed
 * proxies; `sync()` sends them as one batch.
 */
export { advertiseCapabilitySets, CAPABILITY_SETS, capabilitySets, supports } from './capabilities'
export { BatchError, OBJECT_MODEL_CAPABILITY, type BatchOp, type BatchRequest, type BatchResult, type LoadedObject, type Origin } from '../kdm'
export { exchangeBackend, ModelDocument, openDocument, type ChangedEvent, type ModelBackend, type OpenOptions } from './document'
export { Exchange, type ModelDescription } from './exchange'
export { kitModelBackend } from './kitModel'
export { kitDescriptor, registerKit, type KitDescriptor } from './kits'
export type { ConflictEvent, DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, KitModel, ModelPort, PresenceEvent, SavedEvent, SelectionEvent } from './port'
export { NotSyncedError, PropertyNotLoadedError, RequestContext, type CommandMap, type CommandResult, type ModelList, type ModelMap, type ModelObject, type ModelText, type ModelTree, type ModelTreeNode } from './proxy'
export { isModelPort, portFromConnection, portFromEngine, type ConnectionLike, type EngineLike } from './sources'
