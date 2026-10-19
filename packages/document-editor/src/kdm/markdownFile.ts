/**
 * A Markdown file's bytes as a document replica, for a host or an engine that holds the file as
 * bytes (the Document kit). The file is UTF-8; its byte order mark and line endings are its line
 * style (`analyzeText`), kept beside the replica so the file writes back the way it was.
 */
import { Replica, system, type ObjectId } from '@kition/kdm'
import { applyTextEdits, diffText } from './documentMerge'
import { DOCUMENT_BODY, documentSchema } from './documentSchema'
import { analyzeText, createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from './documentText'

// A byte order mark stays in the text, so the line style records it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const encoder = new TextEncoder()

/** The line style of a new file: `\n` endings, no byte order mark. */
export const NEW_FILE_STYLE: LineStyle = { eol: '\n', bom: false, finalNewline: true }

type OpenedMarkdownFile = { replica: Replica; rootId: ObjectId; style: LineStyle }

/** A new document replica of the Markdown file `bytes`. */
export function importMarkdownFile(bytes: Uint8Array, actor: bigint): OpenedMarkdownFile {
  return createDocumentReplica(decoder.decode(bytes), actor)
}

/**
 * The document replica stored for a Markdown file (`snapshot`, a KDM snapshot or a full change
 * export), with what the file `bytes` holds that the replica does not as one `system` import
 * change: the file is the document. Empty `bytes` open the replica alone.
 */
export function openStoredMarkdownFile(bytes: Uint8Array, snapshot: Uint8Array, actor: bigint): OpenedMarkdownFile {
  const replica = Replica.load(documentSchema, snapshot, actor)
  const rootId = documentRootId(replica)
  if (bytes.length === 0) return { replica, rootId, style: NEW_FILE_STYLE }
  const { text, style } = analyzeText(decoder.decode(bytes))
  const current = documentBody(replica, rootId)
  if (current !== text) replica.transact(system('import'), (tx) => applyTextEdits(tx, rootId, DOCUMENT_BODY, diffText(current, text)))
  return { replica, rootId, style }
}

/** The Markdown file of `replica`'s text, written in `style`. */
export function exportMarkdownFile(replica: Replica, style: LineStyle, rootId: ObjectId = documentRootId(replica)): Uint8Array {
  return encoder.encode(renderText(documentBody(replica, rootId), style))
}
