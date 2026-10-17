/**
 * Public entry of the document feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { DocumentCreationPreset } from './lib/documentCreation'
export type { MarkdownImageInsertionContext, MarkdownImageInsertionSnapshot } from './editor/editor/markdown-image-insertion'
export type { DocumentAskAgentRequest } from './lib/documentAgentActions'
export type { DocumentAgentReview, DocumentSession } from './kdm/documentSession'
export type { OpenedDocumentEntry } from './hooks/useWorkspaceDocumentSession'
// Type-only so consumers can name the hook's result without bundling the hook.
export type { useDocumentExport } from './hooks/useDocumentExport'
export {
  buildTranslationMessages,
  cleanTranslationResult,
  TranslationAccountNotReadyError,
  TranslationModelMissingError,
  type DocumentTranslateText,
  type DocumentTranslationSupport,
} from './lib/documentTranslation'
export { relativeMarkdownPath } from './lib/documentImagePaste'
/** Loads the image insertion resolver with the editor chunk; it carries the Markdown parser. */
export const loadMarkdownImageInsertionResolver = () =>
  import('./editor/editor/markdown-image-insertion').then((module) => module.resolveMarkdownImageInsertionContext)
/** Loads the clipboard inspection helpers; they carry the HTML-to-Markdown converter. */
export const loadDocumentClipboard = () => import('./lib/documentClipboard')
/** Loads the bar shown over a document the agent just edited (Accept, Reject, review panel). */
export const loadDocumentAgentReviewBar = () => import('./components/DocumentAgentReviewBar')
/** Loads the Markdown document replica store (opening, saving, identity across renames); it carries the KDM. */
export const loadDocumentStore = () => import('./kdm/documentStore')
export { findOpenMarkdownDocument, followOpenMarkdownDocuments, type OpenMarkdownDocument } from './kdm/openDocumentSessions'
