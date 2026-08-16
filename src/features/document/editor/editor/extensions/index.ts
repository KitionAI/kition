export { wikilinkExtension, type WikilinkExtensionOptions, type WikilinkNavigate, type WikilinkResolver, type WikilinkCreate, wikilinkResolverFacet } from './wikilink'
export { tagExtension, type TagExtensionOptions } from './tag'
export { highlightExtension, commentExtension, blockIdExtension } from './inline-syntax'
export { livePreviewExtension } from './live-preview'
export type { DocumentImagePreviewRequest } from './image-widget-actions'
export { documentKeymap } from './keymap'
export { slashCommandExtension } from './slash'
export { pasteLinkExtension } from './paste-link'
export { autoBracketExtension } from './auto-bracket'
export { tableNextCell, tablePrevCell } from './table-nav'
export { footnotePreviewExtension } from './footnote-preview'
export { pasteImageExtension } from './paste-image'
export { snippetExpandExtension, type SnippetExtensionOptions } from './snippet-expand'
export { wikilinkHoverPreviewExtension } from './wikilink-hover'
export {
  spellcheckExtension,
  isSpellcheckOn,
  setSpellcheck,
  readSpellcheckPref,
} from './spellcheck'
export {
  embedTransclusionExtension,
  type EmbedExtensionOptions,
  type EmbedLoader,
  type EmbedLoadResult,
} from './embed-transclusion'
export { frontmatterWidgetExtension } from './frontmatter-widget'
export { dataviewFieldExtension } from './dataview-field'
export { mathPreviewExtension, findMathSpans, type MathSpan } from './math-preview'
export { mediaDecoExtension, findIframeSpans, findAudioLinks, type IframeSpan, type AudioLinkSpan } from './media-deco'
export {
  focusModeExtension,
  typewriterModeExtension,
  setFocusMode,
  setTypewriterMode,
  isFocusModeOn,
  isTypewriterModeOn,
} from './focus-mode'
export type { SuggestProviders, WikilinkSuggestion, TagSuggestion, AnchorSuggestion, BlockIdSuggestion } from './suggest'
export { editorContextMenuExtension } from './editor-context-menu'
export { headingFoldIndicatorExtension } from './heading-fold-indicator'
export { documentTitleHostExtension, type DocumentTitleHostOptions } from './document-title-host'
export { preserveHighlightExtension } from './preserve-highlight'
export { clickPositionFixExtension } from './click-position-fix'
export { documentSearchExtension } from './document-search-panel'
