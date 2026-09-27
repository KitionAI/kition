/**
 * Public entry of the document feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { DocumentCreationPreset } from './lib/documentCreation'
export type { MarkdownImageInsertionSnapshot } from './editor/editor/markdown-image-insertion'
