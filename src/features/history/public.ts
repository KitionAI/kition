/**
 * Public entry of the version history feature: each document's checkpoints on this device (kept in the document
 * store, `.kition/docs/`), each with its own snapshot; showing a past version and restoring it as one new change. Import from here, never from internal modules (enforced by
 * tooling/dependency-cruiser.cjs).
 */
export { canShowDocumentHistory, DocumentHistoryHost, requestDocumentHistory } from './DocumentHistoryHost'
