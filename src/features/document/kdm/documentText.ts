/**
 * The Markdown file's text as the replica keeps it. Line endings are normalised to `\n` and a
 * leading byte order mark is removed on import; the original style is recorded so that export
 * writes the file back the way it was (CodeMirror would otherwise normalise CRLF itself and keep a
 * byte order mark as U+FEFF inside the text).
 */
import { newDocId, Replica, system, type ObjectId } from '@/lib/kdm'
import { DOCUMENT_BODY, DOCUMENT_ROOT, documentSchema } from './documentSchema'

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)

export type LineEnding = '\n' | '\r\n'

/**
 * How a file writes what the replica keeps as plain `\n` text.
 *
 * - `eol`: the file's line ending; `mixed` when it uses more than one (or lone CR, which export
 *   cannot reproduce). A mixed file exports with `mixedEol`, its majority ending (`\n` when absent).
 * - `bom`: the file starts with a byte order mark.
 * - `finalNewline`: the file ends with a line ending. The replica keeps the final newline as part
 *   of the text, so this is a record for the store's metadata; `renderText` leaves the text's end
 *   as it is.
 */
export type LineStyle = { eol: LineEnding | 'mixed'; bom: boolean; finalNewline: boolean; mixedEol?: LineEnding }

const CR = 13
const LF = 10

/** The file's text for the replica (no BOM, `\n` endings) and the style to write it back with. */
export function analyzeText(raw: string): { text: string; style: LineStyle } {
  const bom = raw.startsWith(BYTE_ORDER_MARK)
  const body = bom ? raw.slice(1) : raw
  let lf = 0
  let crlf = 0
  let cr = 0
  for (let index = 0; index < body.length; index += 1) {
    const unit = body.charCodeAt(index)
    if (unit === LF) lf += 1
    else if (unit === CR) {
      if (body.charCodeAt(index + 1) === LF) {
        crlf += 1
        index += 1
      } else cr += 1
    }
  }
  const text = crlf > 0 || cr > 0 ? normalise(body) : body
  const finalNewline = text.endsWith('\n')
  const kinds = Number(lf > 0) + Number(crlf > 0) + Number(cr > 0)
  if (kinds > 1 || cr > 0) {
    return { text, style: { eol: 'mixed', bom, finalNewline, mixedEol: crlf > lf + cr ? '\r\n' : '\n' } }
  }
  return { text, style: { eol: crlf > 0 ? '\r\n' : '\n', bom, finalNewline } }
}

/**
 * The file text for the replica's `text`: the inverse of `analyzeText`, so
 * `renderText(analyzeText(x).text, analyzeText(x).style) === x` for every file with one line
 * ending style. A CR in `text` (pasted or written by an agent) is normalised first.
 */
export function renderText(text: string, style: LineStyle): string {
  const plain = text.includes('\r') ? normalise(text) : text
  const eol = style.eol === 'mixed' ? (style.mixedEol ?? '\n') : style.eol
  const body = eol === '\r\n' ? plain.replace(/\n/g, '\r\n') : plain
  return style.bom ? BYTE_ORDER_MARK + body : body
}

const normalise = (text: string): string => text.replace(/\r\n?/g, '\n')

/**
 * A new document replica holding the file text `raw`, written in the creating commit so that
 * nothing about the import can be undone. Answers the replica, its `Document` object, and the
 * file's line style.
 */
export function createDocumentReplica(raw: string, actor: bigint, docId: string = newDocId()): { replica: Replica; rootId: ObjectId; style: LineStyle } {
  const { text, style } = analyzeText(raw)
  const { replica, result: rootId } = Replica.createWith(documentSchema, docId, actor, system('create'), (tx) => {
    const id = tx.create(DOCUMENT_ROOT, {})
    if (text) tx.textInsert(id, DOCUMENT_BODY, 0, text)
    return id
  })
  return { replica, rootId, style }
}

/** The document's `Document` object; the smallest id if concurrent creation left several. */
export function documentRootId(replica: Replica): ObjectId {
  const root = replica.objectsOfType(DOCUMENT_ROOT)[0]
  if (root === undefined) throw new Error('The document has no Document object.')
  return root
}

/** The Markdown text of the document (`\n` line endings, no byte order mark). */
export function documentBody(replica: Replica, rootId: ObjectId = documentRootId(replica)): string {
  return replica.text(rootId, DOCUMENT_BODY)
}
