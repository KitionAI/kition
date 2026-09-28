/**
 * Public entry of the document feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { DocumentCreationPreset } from './lib/documentCreation'
export type { MarkdownImageInsertionSnapshot } from './editor/editor/markdown-image-insertion'
export type { DocumentAskAgentRequest } from './lib/documentAgentActions'
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
