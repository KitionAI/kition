// Copied from kition-sdk packages/sync/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `@kition/sync`: the client for the open sync protocol `kition-sync/1` (Kit Harness Protocol (KHP) spec/reference/sync-protocol.md).
 * `SyncClient` connects over an injectable `SyncTransport`, reconnects with backoff, re-joins
 * every joined room with the caller's latest local version, and queues pushes made while
 * offline, flushing them in order once reconnected. `startRelay` relays one document's KDM replica
 * to and from its room through it. `LORO_REPLICA_VERSIONS`, the version handling the relay needs,
 * is in `@kition/sync/replicaVersions`, loaded on demand, since it loads the CRDT engine.
 */
export { capabilitySetsOf, parseCapabilitySet, servesCapabilitySet } from './capabilities'
export { blobHashCandidates, decodeBlobSection, encodeBlobSection, type BlobEntry } from './blobSection'
export { SyncClient, type SnapshotStart, type SyncClientOptions, type SyncToken } from './client'
export type { Bin, Frame } from './framing'
export {
  HEADLESS_CAPABILITY,
  SYNC_PROTOCOL,
  SyncRpcError,
  type AgentRunResult,
  type BlobGetResult,
  type BlobHasResult,
  type ChangesPullParams,
  type Checkpoint,
  type ChangesPushResult,
  type ClientInfo,
  type ErrorCode,
  type ExportGetResult,
  type HelloParams,
  type HelloResult,
  type HistoryGetResult,
  type HistoryListResult,
  type HistoryRestoreResult,
  type Lease,
  type Member,
  ROLE_RANK,
  type RoomAccessParams,
  type RoomMembersResult,
  type ShareLink,
  type LeaseChangedParams,
  type Presence,
  type PresenceUpdateParams,
  type PreviewGetResult,
  type Principal,
  type Role,
  type AccountSettings,
  type PrivateRoomCreateResult,
  type RoomCreateResult,
  type RoomListing,
  type RoomsChangedParams,
  type RoomsListResult,
  type RoomJoinResult,
  type RoomLinkResult,
  type RoomOpenResult,
  type ServerInfo,
  type SnapshotGetResult,
  type SnapshotPreference,
} from './protocol'
export { DocumentLeases, SyncLeases, leaseHolder, scopesCollide, type LeaseHold } from './leases'
export { startRelay, type Relay, type RelayOptions, type RelayReplica, type RelaySync } from './relay'
export type { ReplicaVersions } from './replicaVersions'
export type { ConnectionState, SyncTransport, TransportFactory } from './transport'
