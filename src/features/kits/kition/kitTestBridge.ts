import type { KitConnection } from '../host/mountKit'

declare global {
  interface Window {
    /** Development builds only: what end-to-end tests read from the kit editors open in this window. */
    __KITION_KIT_TEST__?: {
      /** The replica version (lowercase hex) of the kit editor showing `path`. */
      replicaVersion: (path: string) => Promise<string>
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
  }
  return () => {
    if (frames.get(path) === connection) frames.delete(path)
  }
}
