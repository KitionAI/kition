/**
 * A new `.kiboard` file made from a board someone shared (co-editing's Open shared document): the
 * room's snapshot becomes the file's replica as it is, so the file is that same document (its KDM
 * id) and its editor co-edits it.
 */
import { randomActor, Replica } from '@/lib/kdm'
import { writeWorkspaceDocument } from '@/services/desktop'
import { encodeBoardFile } from './boardKdmFile'
import { boardSchema } from './boardSchema'

/**
 * Writes the board `bytes` (a KDM snapshot or a full change export) to `path`, where there must be
 * no file yet, in the workspace `root`. Answers the replica version the file holds.
 */
export async function writeBoardFileFromReplica(path: string, bytes: Uint8Array, root: string): Promise<Uint8Array> {
  const replica = Replica.load(boardSchema, bytes, randomActor())
  await writeWorkspaceDocument(path, encodeBoardFile(replica), { expected_root: root, expected_content: null, expected_missing: true })
  return replica.version().encode()
}
