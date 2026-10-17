// Copied from kition-sdk packages/sync/src/protocol.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The open sync protocol, `kition-sync/1` (docs/sync-protocol.md): JSON-RPC 2.0 messages over a
 * WebSocket. Binary payloads (KDM change bytes, snapshots, blobs) travel as separate binary
 * frames; see `./framing`. These are the JSON-visible shapes, with binary fields as `Uint8Array`
 * (the wire's `{"$bin": n}` markers are an encoding detail `./framing` and `./client` handle).
 */

export const SYNC_PROTOCOL = 'kition-sync/1'

export type Role = 'owner' | 'editor' | 'viewer'

/** `error.data.code` (never the JSON-RPC `code`/`message`, which are for logs and people). */
export type ErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'unavailable'

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
export type RoomJoinResult = { changes: Uint8Array[]; seq: number; more: boolean; presence: Presence[]; role: Role }

export type ChangesPushParams = { docId: string; changes: Uint8Array }
export type ChangesPushResult = { seq: number }

/** Server to client, notification. */
export type ChangesPullParams = { docId: string; changes: Uint8Array; seq: number; from: string }

/** Client to server, notification: ephemeral, never persisted. */
export type PresenceSetParams = { docId: string; state: unknown }

/** Server to client, notification: replaces the room's peer list. */
export type PresenceUpdateParams = { docId: string; peers: Presence[] }

export type BlobHasParams = { hashes: string[] }
export type BlobHasResult = { missing: string[] }

export type BlobPutParams = { hash: string; mime: string; data: Uint8Array }
export type BlobPutResult = Record<string, never>

export type BlobGetParams = { hash: string }
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
 * (`editor` or `viewer`, never more than the caller's own role): a view-only link, say, next to
 * the editing link `room/create` answered.
 */
export type RoomLinkParams = { docId: string; role: Exclude<Role, 'owner'> }
export type RoomLinkResult = { shareLink: string }

/** Client to server, notification. */
export type RoomLeaveParams = { docId: string }

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
