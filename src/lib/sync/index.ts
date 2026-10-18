// Copied from kition-sdk packages/sync/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `@kition/sync`: the client for the open sync protocol `kition-sync/1` (docs/sync-protocol.md).
 * `SyncClient` connects over an injectable `SyncTransport`, reconnects with backoff, re-joins
 * every joined room with the caller's latest local version, and queues pushes made while
 * offline, flushing them in order once reconnected. `startRelay` relays one document's KDM replica
 * to and from its room through it. `LORO_REPLICA_VERSIONS`, the version handling the relay needs,
 * is in `@kition/sync/replicaVersions`, loaded on demand, since it loads the CRDT engine.
 */
export { blobHashCandidates, decodeBlobSection, encodeBlobSection, type BlobEntry } from './blobSection'
export { SyncClient, type SyncClientOptions } from './client'
export type { Bin, Frame } from './framing'
export {
  SYNC_PROTOCOL,
  SyncRpcError,
  type BlobGetResult,
  type BlobHasResult,
  type ChangesPullParams,
  type ChangesPushResult,
  type ClientInfo,
  type ErrorCode,
  type HelloParams,
  type HelloResult,
  type Presence,
  type PresenceUpdateParams,
  type Principal,
  type Role,
  type RoomCreateResult,
  type RoomJoinResult,
  type RoomLinkResult,
  type RoomOpenResult,
  type ServerInfo,
  type SnapshotGetResult,
} from './protocol'
export { startRelay, type Relay, type RelayOptions, type RelayReplica, type RelaySync } from './relay'
export type { ReplicaVersions } from './replicaVersions'
export type { ConnectionState, SyncTransport, TransportFactory } from './transport'
