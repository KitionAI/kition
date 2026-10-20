/**
 * Schema evolution in the documents Kition edits itself, boards and Markdown documents (Kit
 * Standard 2.0 rule M5a), as kit editors report it for theirs (Kit UI protocol `document/schema`):
 * a document whose replica holds changes a newer kit wrote gets a notice that does not block
 * editing (`@/services/documentSchema`). Its replica is read when the document opens and when the
 * editor replaces it (a file replaced on disk); the relay reads it after every import
 * (`./schemaWatch`). A document a newer kit migrated does not open here at all: its editor says
 * so (a board's `newer-version`), and a relayed change of that kind blocks from the relay.
 */
import { followOpenMarkdownDocuments } from '@/features/document/public'
import { followOpenBoards } from '@/features/whiteboard/public'
import type { Replica } from '@/lib/kdm'
import { documentSchemaNotice, setDocumentSchemaNotice, type DocumentSchemaNotice } from '@/services/documentSchema'
import { HOST_KITS } from './collabDocuments'

type PageDocument = { path: string; replica: () => Replica; subscribe: (listener: () => void) => () => void }

/** The notice `replica` calls for: a newer kit wrote some of its changes; `null` when none did. */
export function newerAuthorNotice(replica: Replica, kit: string): DocumentSchemaNotice | null {
  const reads = replica.schema.schemaVersion
  const author = replica.authorSchemaVersion()
  return author !== null && author > reads ? { kit, reads, needs: author, blocked: false } : null
}

function follow(document: PageDocument, kit: string) {
  const { path } = document
  let replica: Replica | null = null
  let notice: DocumentSchemaNotice | null = null
  const check = () => {
    let current: Replica
    try {
      current = document.replica()
    } catch {
      return
    }
    // Reading every change's author is not for each keystroke: only a replica not read yet.
    if (current !== replica) {
      replica = current
      const next = newerAuthorNotice(current, kit)
      if (!next && notice && documentSchemaNotice(path)?.blocked === false) setDocumentSchemaNotice(path, null)
      notice = next
    }
    // Shown again when something else took it down while the document is open (a relay stopping).
    if (notice && !documentSchemaNotice(path)) setDocumentSchemaNotice(path, notice)
  }
  check()
  const stop = document.subscribe(check)
  return () => {
    stop()
    if (notice && documentSchemaNotice(path)?.blocked === false) setDocumentSchemaNotice(path, null)
  }
}

/** Follows every open board and Markdown document for a newer kit's changes; answers the stop. */
export function followPageSchemaNotices() {
  const stops = [followOpenBoards((board) => follow(board, HOST_KITS.board)), followOpenMarkdownDocuments((document) => follow(document, HOST_KITS.document))]
  return () => {
    for (const stop of stops) stop()
  }
}

