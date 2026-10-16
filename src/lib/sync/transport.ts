// Copied from kition-sdk packages/sync/src/transport.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The transport `SyncClient` needs: the slice of the browser `WebSocket` API it uses, so a real
 * `WebSocket` (with `binaryType = "arraybuffer"`) satisfies it directly, and a test can supply an
 * in-memory fake instead. `createTransport(url)` makes a fresh one for each connection attempt;
 * `SyncClient` assigns its own `onopen`/`onclose`/`onerror`/`onmessage`, so a transport MUST
 * support being told them (not just constructor callbacks).
 */
export interface SyncTransport {
  send(data: string | Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: ((error: unknown) => void) | null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null
}

export type TransportFactory = (url: string) => SyncTransport

export type ConnectionState = 'connecting' | 'online' | 'offline'
