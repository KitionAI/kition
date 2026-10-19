/**
 * `@kition/document-editor/file`: a Markdown file as a document on the Kit Data Model, without the
 * editor (no CodeMirror): its schema (`kit.document`), the file text as the replica keeps it, text
 * merges, and the file's bytes. What an engine in a worker needs (the Document kit's).
 */
export { applyTextEdits, diffText } from './kdm/documentMerge'
export { DOCUMENT_BODY, documentSchema } from './kdm/documentSchema'
export { analyzeText, createDocumentReplica, documentBody, documentRootId, type LineStyle } from './kdm/documentText'
export { exportMarkdownFile, importMarkdownFile, NEW_FILE_STYLE, openStoredMarkdownFile } from './kdm/markdownFile'
