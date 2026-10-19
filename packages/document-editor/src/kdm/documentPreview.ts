/** A Markdown document as it was at a point of its history, for the version history's preview and restore. */
import { randomActor, Replica } from '@kition/kdm'
import { documentSchema } from './documentSchema'
import { documentBody, documentRootId } from './documentText'

/** The text of the document `snapshot` holds (a KDM snapshot or a full change export). */
export function documentPreviewText(snapshot: Uint8Array): string {
  const replica = Replica.load(documentSchema, snapshot, randomActor())
  return documentBody(replica, documentRootId(replica))
}
