/**
 * `@kition/document-editor/model`: a Markdown document on the Kit Data Model: its schema
 * (`kit.document`), the file text as the replica keeps it, text merges, the CodeMirror binding of
 * the replica's text, its undo and redo, and a standalone text source.
 */
export { applyChangeSet, deltaToChanges, replicaChange, TextBinding, type TextBindingOptions } from './kdm/codeMirrorBinding'
export { documentHistoryExtension, redoDocument, undoDocument, type DocumentHistory } from './kdm/documentHistory'
export { applyEditsToString, applyTextEdits, coalesceEdits, diffText, mergeEdits, mergeExternalText, type MergeOptions, type TextEdit } from './kdm/documentMerge'
export { documentPreviewText } from './kdm/documentPreview'
export { DOCUMENT_BODY, DOCUMENT_KIT, DOCUMENT_ROOT, documentSchema } from './kdm/documentSchema'
export { analyzeText, createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from './kdm/documentText'
export { createReplicaTextSource, type DocumentTextSource } from './kdm/documentTextSource'
