// Copied from kition-sdk packages/sync/src/protocol.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The open sync protocol, `kition-sync/1` (docs/sync-protocol.md): JSON-RPC 2.0 messages over a
 * WebSocket. Binary payloads (KDM change bytes, snapshots, blobs) travel as separate binary
 * frames; see `./framing`. These are the JSON-visible shapes, with binary fields as `Uint8Array`
 * (the wire's `{"$bin": n}` markers are an encoding detail `./framing` and `./client` handle).
 */

export const SYNC_PROTOCOL = 'kition-sync/1'

/**
 * A room's role for one principal: `owner` and `editor` may push any change, `commenter` (protocol
 * 1.6) only changes that touch comment objects (Kit Standard 2.0 rule M23), `viewer` none.
 */
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer'

/** Roles by what they allow: `viewer` < `commenter` < `editor` < `owner`. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 }

/** `error.data.code` (never the JSON-RPC `code`/`message`, which are for logs and people). */
export type ErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'rate-limited'

export type ClientInfo = { name: string; version: string }
export type ServerInfo = { name: string; version: string }
export type Principal = { id: string; name: string }

/** One peer's presence in a room; `state` is a kit's own ephemeral cursor/selection shape. */
export type Presence = { principalId: string; name: string; color: string; state: unknown }

export type HelloParams = { protocol: string; token: string; client: ClientInfo; capabilities: string[] }
export type HelloResult = { server: ServerInfo; principal: Principal; capabilities: string[] }

/**
 * Catch-up is by the room's own server sequence, not a KDM version, so the server never needs a
 * replica of its own to answer it. `since` is the highest `seq` the caller already has (`null`:
 * none, catch up from the room's snapshot). A room can have more changes than fit in one
 * message's binary frames, so the result pages: `limit` caps how many changes come back (a
 * server may cap it lower still; omitted asks for the server's own default). When `more` is
 * `true`, `seq` is the last included change's `seq` (not the room's latest) and the caller
 * repeats `room/join` with `since` set to it; when `more` is `false`, `seq` is the room's latest.
 */
export type RoomJoinParams = { docId: string; since: number | null; limit?: number }
/**
 * `snapshot` (protocol 1.5): `since` was older than the history the server keeps change by change,
 * so `changes[0]` is a snapshot of the document (imported like any change set) and the rest follow it.
 */
export type RoomJoinResult = { changes: Uint8Array[]; seq: number; more: boolean; presence: Presence[]; role: Role; snapshot?: boolean }

export type ChangesPushParams = { docId: string; changes: Uint8Array }
export type ChangesPushResult = { seq: number }

/** Server to client, notification. */
export type ChangesPullParams = { docId: string; changes: Uint8Array; seq: number; from: string }

/** Client to server, notification: ephemeral, never persisted. */
export type PresenceSetParams = { docId: string; state: unknown }

/** Server to client, notification: replaces the room's peer list. */
export type PresenceUpdateParams = { docId: string; peers: Presence[] }

/**
 * Blobs are scoped to documents (protocol 1.5): `blob/put` records that `docId` references the
 * blob, and `blob/has`/`blob/get` answer only blobs `docId` references, for a principal that may
 * read its room. A blob another document references is `missing` here until this one uploads it.
 */
export type BlobHasParams = { docId: string; hashes: string[] }
export type BlobHasResult = { missing: string[] }

export type BlobPutParams = { docId: string; hash: string; mime: string; data: Uint8Array }
export type BlobPutResult = Record<string, never>

export type BlobGetParams = { docId: string; hash: string }
export type BlobGetResult = { data: Uint8Array; mime: string }

export type SnapshotGetParams = { docId: string }
export type SnapshotGetResult = { snapshot: Uint8Array; seq: number }

export type RoomCreateParams = { docId: string; snapshot: Uint8Array; name: string; kit: string }
export type RoomCreateResult = { shareLink: string }

/**
 * Resolves a share link (`RoomCreateResult.shareLink`) to the room it points to and the role the
 * caller would join it with; it does not itself join the room (send `room/join` with `docId` for
 * that).
 */
export type RoomOpenParams = { shareLink: string }
export type RoomOpenResult = { docId: string; name: string; kit: string; role: Role }

/**
 * Mints another share link to a room the caller is a member of (protocol 1.4), granting `role`
 * (`editor`, `commenter` since 1.6, or `viewer`, never more than the caller's own role): a view-only link, say, next to
 * the editing link `room/create` answered.
 */
export type RoomLinkParams = { docId: string; role: Exclude<Role, 'owner'> }
export type RoomLinkResult = { shareLink: string }

/** A member of a room (protocol 1.6): `name` is the display name they last joined with. */
export type Member = { principalId: string; name: string; role: Role }
/** A share link that still works (protocol 1.6): the role it grants and who minted it. */
export type ShareLink = { shareLink: string; role: Exclude<Role, 'owner'>; createdBy: string }
/** `room/members` (protocol 1.6): for the room's owner or an editor. */
export type RoomMembersParams = { docId: string }
export type RoomMembersResult = { members: Member[]; links: ShareLink[] }
/** `room/setRole` (protocol 1.6): the owner changes another member's role. */
export type RoomSetRoleParams = { docId: string; principalId: string; role: Exclude<Role, 'owner'> }
/** `room/removeMember` (protocol 1.6): the owner removes another member. */
export type RoomRemoveMemberParams = { docId: string; principalId: string }
/** `room/revokeLink` (protocol 1.6): the owner revokes a share link. */
export type RoomRevokeLinkParams = { docId: string; shareLink: string }
/** Server to client, notification (protocol 1.6): the receiver's role changed; `null`: removed. */
export type RoomAccessParams = { docId: string; role: Role | null }

/** Client to server, notification. */
export type RoomLeaveParams = { docId: string }

/** `history/list` (protocol 1.5): checkpoints newest first, before `before` (omitted: the latest). */
export type HistoryListParams = { docId: string; before?: number; limit?: number }
/**
 * A point the document's history can be read at or restored to: a run of changes one principal
 * pushed (`kind: 'changes'`, `firstSeq`..`seq`), or a snapshot older history was compacted into.
 * `time` is milliseconds since the Unix epoch.
 */
export type Checkpoint = { seq: number; firstSeq: number; time: number; principalId: string | null; changes: number; kind: 'changes' | 'snapshot' }
/** `more`: older checkpoints remain; ask again with `before` set to the last one's `firstSeq`. */
export type HistoryListResult = { checkpoints: Checkpoint[]; more: boolean }

/** `history/get` (protocol 1.5): the document as of `seq` (or the nearest snapshot before it, which `seq` names). */
export type HistoryGetParams = { docId: string; seq: number }
export type HistoryGetResult = { snapshot: Uint8Array; seq: number }

/**
 * `history/restore` (protocol 1.5): an owner or editor of a joined room restores the document as of
 * `seq` as one new change, which every member, the caller too, receives as `changes/pull`. `seq` is
 * that change's (`null`: the document was already in that state); `restored` is the state's `seq`.
 */
export type HistoryRestoreParams = { docId: string; seq: number }
export type HistoryRestoreResult = { seq: number | null; restored: number }

/**
 * A lease on one scope of a room (protocol 1.5, section 8): who holds it, the holder's session
 * (opaque; it tells a client its own leases from others'), and `ttl`, the milliseconds it had left
 * when sent (informational: a lease ends only when `lease/changed` drops it).
 */
export type Lease = { scope: string; principalId: string; name: string; session: string; ttl: number }

/** `lease/acquire`: `ttl` in milliseconds (omitted: the server's default, 30 000; a server clamps it). */
export type LeaseAcquireParams = { docId: string; scope: string; ttl?: number }
export type LeaseAcquireResult = { lease: Lease }
export type LeaseReleaseParams = { docId: string; scope: string }
/** Server to client, notification: replaces the room's lease list. */
export type LeaseChangedParams = { docId: string; leases: Lease[] }

/** The capability a server lists in `sync/hello` when it runs kits headless (protocol 1.7, section 8a). */
export const HEADLESS_CAPABILITY = 'headless'

/**
 * `preview/get` (protocol 1.7): a picture of the room's document as of its latest change, rendered
 * by the kit on the server. `page` is zero-based, for a kit that pages; `size` the longest side in
 * pixels (the server's default when omitted, and capped).
 */
export type PreviewGetParams = { docId: string; page?: number; size?: number }
export type PreviewGetResult = { image: Uint8Array; mimeType: string; width: number; height: number; seq: number }

/** `export/get` (protocol 1.7): the room's document as a file in `format` (the kit's native one when omitted). */
export type ExportGetParams = { docId: string; format?: string }
export type ExportGetResult = { data: Uint8Array; name: string; format: string; seq: number }

/**
 * `agent/run` (protocol 1.7): an object-model batch (`{ ops, load? }`) the server runs on the
 * joined room's document in its headless kit, as an agent acting for the caller (an owner or
 * editor); the server sets the origin. What it changed arrives as `changes/pull` like anyone
 * else's change; `seq` is that change's (`null` when the batch changed nothing).
 */
export type AgentRunParams = { docId: string; batch: unknown; prompt?: string }
export type AgentRunResult = { seq: number | null; result: unknown }

/** A JSON-RPC error; `data.code` is an [[ErrorCode]] for every error this protocol itself defines. */
export class SyncRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }

  /** This error's [[ErrorCode]], when it carries one. */
  get reason(): ErrorCode | undefined {
    const data = this.data as { code?: unknown } | undefined
    return typeof data?.code === 'string' ? (data.code as ErrorCode) : undefined
  }
}
