/**
 * `@kition/document-editor/editor`: the Markdown editor (CodeMirror with live preview, widgets,
 * paste and image handling) over a `DocumentTextSource`. Set the page's `DocumentHost` first
 * (every member optional); the editor translates with i18next in the `document` namespace.
 */
export { DocumentEditor, type CursorInfo } from './editor/DocumentEditor'
export * from './editor/extensions'
export { useDocumentBinding } from './hooks/useDocumentBinding'
export { addSnippet, removeSnippet, useSnippets } from './hooks/useSnippets'
