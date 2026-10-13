import { parseSchema, type Schema } from '@/lib/kdm'

export const DOCUMENT_KIT = 'kit.document'

/** The root type and its one field: the Markdown text, line endings normalised to `\n`. */
export const DOCUMENT_ROOT = 'Document'
export const DOCUMENT_BODY = 'body'

/**
 * A Markdown document on the KDM: one text field. Markdown structure (headings, tables,
 * frontmatter) stays in the text; widgets are views and edits of the same text.
 */
export const documentSchema: Schema = parseSchema({
  kdm: 1,
  kit: DOCUMENT_KIT,
  schemaVersion: 1,
  root: DOCUMENT_ROOT,
  types: { [DOCUMENT_ROOT]: { fields: { [DOCUMENT_BODY]: { kind: 'text' } } } },
})
