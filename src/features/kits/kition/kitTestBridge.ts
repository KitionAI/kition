import { setReadOnlyDocuments } from '@/services/documentAccess'
import type { KitConnection } from '../host/mountKit'

declare global {
  interface Window {
    /** Development builds only: what end-to-end tests read from the kit editors open in this window. */
    __KITION_KIT_TEST__?: {
      /** The replica version (lowercase hex) of the kit editor showing `path`. */
      replicaVersion: (path: string) => Promise<string>
      /** The live document of the kit editor showing `path`, as the Kit AI bridge's `inspect` answers it. */
      inspect: (path: string) => Promise<Record<string, unknown>>
      /** Makes these documents read-only, as a role change to viewer does (their editors open again). */
      setReadOnlyDocuments: (paths: string[]) => void
    }
  }
}

const frames = new Map<string, KitConnection>()

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Offers the kit editor of `path` to end-to-end tests (development builds only); answers its withdrawal. */
export function registerKitTestFrame(path: string, connection: KitConnection) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => undefined
  frames.set(path, connection)
  window.__KITION_KIT_TEST__ ??= {
    replicaVersion: async (wanted) => {
      const frame = frames.get(wanted)
      if (!frame) throw new Error(`${wanted} is not open in a kit editor`)
      return hex(await frame.replica.version())
    },
    inspect: async (wanted) => {
      const frame = frames.get(wanted)
      if (!frame) throw new Error(`${wanted} is not open in a kit editor`)
      return frame.ai.inspect()
    },
    setReadOnlyDocuments,
  }
  return () => {
    if (frames.get(path) === connection) frames.delete(path)
  }
}
