import { COMMENT_THREAD_TYPE, COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE, COMMENT_TYPE_DEF, parseSchema, type Schema } from '@kition/kdm'

export const DOCUMENT_KIT = 'kit.document'

/** The root type and its one field: the Markdown text, line endings normalised to `\n`. */
export const DOCUMENT_ROOT = 'Document'
export const DOCUMENT_BODY = 'body'

/**
 * A Markdown document on the KDM: one text field. Markdown structure (headings, tables,
 * frontmatter) stays in the text; widgets are views and edits of the same text. Version 2 adds
 * comment threads beside the text (Kit Standard 2.0 rule M23), anchored to a range of the body;
 * they live in the replica only, never in the Markdown file.
 */
export const documentSchema: Schema = parseSchema({
  kdm: 1,
  kit: DOCUMENT_KIT,
  schemaVersion: 2,
  root: DOCUMENT_ROOT,
  types: {
    [DOCUMENT_ROOT]: { fields: { [DOCUMENT_BODY]: { kind: 'text' } } },
    [COMMENT_THREAD_TYPE]: COMMENT_THREAD_TYPE_DEF,
    [COMMENT_TYPE]: COMMENT_TYPE_DEF,
  },
})
