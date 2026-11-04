// Copied from kition-sdk packages/sync/src/saveMachine.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The save state machine of a co-edited room (managed co-editing card D3,
 * Kition platform docs/platform/managed-collab.md section 3): one state per room, kept by the sync
 * server and broadcast to every connection (`save/changed`), so every editor shows the same saved
 * state and exactly one session saves at a time. `saveTransition` is the whole rule set: Kition
 * Server applies it (the Rust twin is `kition_sync_protocol::save`), `FakeServer` too, and both
 * are held to `crates/kition-sync-protocol/tests/save-transitions.json`.
 */

/**
 * `editing`: people edit (`dirty` says whether the room is ahead of the last version);
 * `force-save`: one session saves now; `must-save`: the last editor left with unsaved changes,
 * the next editor saves first; `corrupted`: a save was rejected as corrupt, saving stops until a
 * good save; `closed`: everyone left and the room is clean.
 */
export type SaveStatus = 'editing' | 'force-save' | 'must-save' | 'corrupted' | 'closed'
/** What started a save: the person (Save), the autosave timer, or a command (an agent, the host, an API). */
export type SaveTrigger = 'user' | 'timer' | 'command'
/** Why a save ended without a version. */
export type SaveFailure = 'conflict' | 'failed' | 'corrupted'

export type SaveState = {
  status: SaveStatus
  dirty: boolean
  /** The room's latest change. */
  headSeq: number
  /** The change the last version holds. */
  savedSeq: number
  /** The host's last version. */
  version: string | null
  /** The running or last save's trigger. */
  trigger: SaveTrigger | null
  /** The session (connection) running the save now (`force-save`), or that ran the last one; not a person (I5). */
  by: string | null
  /** The last failure, until a save succeeds. */
  reason: SaveFailure | null
  /** The change the running save writes (`force-save` only). */
  savingSeq: number | null
}

export type SaveEvent =
  /** A change the room took, from `by`. */
  | { type: 'change'; seq: number; by: string }
  /** An editor joined the room. */
  | { type: 'joined'; by: string }
  /** `save/begin`. */
  | { type: 'begin'; by: string; trigger: SaveTrigger }
  /** `save/end`: `version` on success, else `error`. */
  | { type: 'end'; by: string; seq: number; version: string | null; error?: SaveFailure }
  /** An editor's connection left; `last` when no editor remains. */
  | { type: 'left'; by: string; last: boolean }

/** `refused`: `conflict` (another save runs), `forbidden` (not this session's save), `invalid` (bad `seq`, or no version and no error). */
export type SaveOutcome = { state: SaveState; refused?: 'conflict' | 'forbidden' | 'invalid'; changed: boolean }

/** The longest host version a save may report (I6). */
export const SAVE_VERSION_LIMIT = 256

/** A new room's save state: its creation snapshot is the version it was seeded from. */
export function initialSaveState(version: string | null = null): SaveState {
  return { status: 'editing', dirty: false, headSeq: 0, savedSeq: 0, version, trigger: null, by: null, reason: null, savingSeq: null }
}

const same = (a: SaveState, b: SaveState) => (Object.keys(a) as (keyof SaveState)[]).every((key) => a[key] === b[key])

function outcome(before: SaveState, state: SaveState, refused?: SaveOutcome['refused']): SaveOutcome {
  return refused ? { state: before, refused, changed: false } : { state, changed: !same(before, state) }
}

/** The room's next save state after `event` (section 3); a refused event leaves it as it was. */
export function saveTransition(state: SaveState, event: SaveEvent): SaveOutcome {
  switch (event.type) {
    case 'change': {
      const headSeq = Math.max(state.headSeq, event.seq)
      const status = state.status === 'closed' ? 'editing' : state.status
      return outcome(state, { ...state, headSeq, dirty: headSeq > state.savedSeq, status })
    }
    case 'joined':
      return outcome(state, state.status === 'closed' ? { ...state, status: 'editing' } : state)
    case 'begin': {
      if (state.status === 'force-save') return outcome(state, state, state.by === event.by ? undefined : 'conflict')
      // A clean room needs no version unless the person asked for one (SV2).
      if (!state.dirty && event.trigger !== 'user') return outcome(state, state)
      return outcome(state, { ...state, status: 'force-save', trigger: event.trigger, by: event.by, savingSeq: state.headSeq })
    }
    case 'end': {
      if (state.status !== 'force-save' || state.by !== event.by) return outcome(state, state, 'forbidden')
      if (event.seq !== state.savingSeq) return outcome(state, state, 'invalid')
      if (event.error === undefined && (event.version == null || typeof event.version !== 'string')) return outcome(state, state, 'invalid')
      if (event.version != null && (typeof event.version !== 'string' || !event.version || event.version.length > SAVE_VERSION_LIMIT)) return outcome(state, state, 'invalid')
      if (event.error === 'corrupted') return outcome(state, { ...state, status: 'corrupted', reason: 'corrupted', savingSeq: null })
      if (event.error) return outcome(state, { ...state, status: 'editing', reason: event.error, savingSeq: null })
      const savedSeq = event.seq
      return outcome(state, { ...state, status: 'editing', savedSeq, version: event.version, dirty: state.headSeq > savedSeq, reason: null, savingSeq: null })
    }
    case 'left': {
      let next = state
      // A save whose session went away ends without a version; nothing it wrote is assumed.
      if (state.status === 'force-save' && state.by === event.by) next = { ...next, status: 'editing', savingSeq: null }
      if (event.last && next.status !== 'corrupted') next = { ...next, status: next.dirty ? 'must-save' : 'closed' }
      return outcome(state, next)
    }
  }
}

/** Whether a session joining a room in `state` must save before anything else (SV4). */
export function mustSave(state: SaveState) {
  return state.status === 'must-save'
}
