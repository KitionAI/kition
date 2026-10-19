/**
 * `@kition/document-editor`: the host seam, the agent action types, pasted and dropped images (kept
 * as the host's files) and their failures, and the Markdown parsers the app shares with the editor
 * (wikilinks, tags, frontmatter). It loads neither
 * the Kit Data Model nor the editor: the model is `@kition/document-editor/model`, the editor
 * `@kition/document-editor/editor`, its commands `@kition/document-editor/commands`.
 */
export { setDocumentHost, type DocumentHost } from './host'
export type { DocumentAgentAction, DocumentAgentActionRequest, DocumentAskAgentRequest } from './lib/documentAgentActions'
export { ImageImportError, imageImportFailure } from './lib/imageImportError'
export { parseFrontmatter } from './lib/frontmatter-parser'
export { applyFrontmatter, fieldsFromParsed, type EditableField } from './lib/frontmatter-serialize'
export { persistBlobImageLinks } from './lib/documentAssetPersistence'
export { notifyImageImportFailure } from './lib/documentImageImportFeedback'
export {
  canPasteNativeDocumentClipboardImage,
  collectDocumentClipboardImages,
  documentClipboardImagesFromFiles,
  importDocumentClipboardImages,
  relativeMarkdownPath,
} from './lib/documentImagePaste'
export { parseTags, type TagParsed } from './lib/tag-parser'
export { parseWikilinks } from './lib/wikilink-parser'
