// Copied from kition-sdk packages/sync/src/saveRun.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * One save of a co-edited room through its save state machine (D3, Kition platform
 * docs/platform/managed-collab.md section 3, rules SV1 to SV4): `save/begin`, the host write of one
 * version with its authors, `save/end`, then the checkpoint (CK1). A host side runs it for the
 * person's Save (`user`), its autosave timer (`timer`), and commands (`command`), and as soon as it
 * joins a room in `must-save`.
 */
import type { SyncClient } from './client'
import { SyncRpcError, type SaveAuthor } from './protocol'
import type { SaveFailure, SaveTrigger } from './saveMachine'

export type SaveRunOptions = {
  client: Pick<SyncClient, 'saveBegin' | 'saveEnd'>
  docId: string
  trigger: SaveTrigger
  /**
   * Writes the document as one host version (SV1): the kit's bytes through the host's conditional
   * write, with the server's `receipt` (the host verifies it and takes the authors from it, I6),
   * the `authors` of the changes up to `seq` as shown here, and the `trigger`. Answers the version.
   */
  write: (save: { seq: number; authors: SaveAuthor[]; trigger: SaveTrigger; receipt: string }) => Promise<string>
  /** After a saved version: keeps the replica as the file's checkpoint for `version` (CK1). A failure here does not undo the save. */
  checkpoint?: (save: { seq: number; version: string }) => Promise<void>
  /** Why `write` failed: `conflict` for a stale or refused version (SV3), `corrupted`, else `failed`. */
  classify?: (error: unknown) => SaveFailure
}

/** `saved`: one version; `clean`: nothing to save; `busy`: another session saves now; `failed`: the edits stay in the room. */
export type SaveRun =
  | { status: 'saved'; version: string; seq: number; authors: SaveAuthor[]; checkpointed: boolean }
  | { status: 'clean' }
  | { status: 'busy' }
  | { status: 'failed'; error: SaveFailure; cause: unknown }

/** The default `classify`: an error whose `code` or `reason` is `conflict` or `corrupted` says so; anything else failed. */
export function classifySaveError(error: unknown): SaveFailure {
  const record = (error ?? {}) as { code?: unknown; reason?: unknown; data?: { reason?: unknown } }
  for (const value of [record.code, record.reason, record.data?.reason]) if (value === 'conflict' || value === 'corrupted') return value
  return 'failed'
}

export async function runSave(options: SaveRunOptions): Promise<SaveRun> {
  const { client, docId, trigger } = options
  let begun: Awaited<ReturnType<SyncClient['saveBegin']>>
  try {
    begun = await client.saveBegin(docId, trigger)
  } catch (error) {
    if (error instanceof SyncRpcError && error.reason === 'conflict') return { status: 'busy' }
    throw error
  }
  if (begun.save.status !== 'force-save') return { status: 'clean' }
  const { seq, authors, receipt } = begun
  let version: string
  try {
    version = await options.write({ seq, authors, trigger, receipt })
  } catch (cause) {
    const error = (options.classify ?? classifySaveError)(cause)
    // The write's failure is the outcome. A connection that dropped meanwhile cannot report it,
    // and needs not: the server ends a save whose connection drops (back to editing, dirty).
    await client.saveEnd(docId, seq, { error }).catch(() => undefined)
    return { status: 'failed', error, cause }
  }
  await client.saveEnd(docId, seq, { version })
  let checkpointed = false
  if (options.checkpoint) {
    try {
      await options.checkpoint({ seq, version })
      checkpointed = true
    } catch {
      checkpointed = false
    }
  }
  return { status: 'saved', version, seq, authors, checkpointed }
}
