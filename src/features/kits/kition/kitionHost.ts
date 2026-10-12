import { writeKitFile } from '@/api/kits'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import { stampFromHeaders, type KitHost } from '../sdk/kitHost'

/** Kition's workspace as a kit host: files over the loopback API, saves through `PUT /v1/kits/files`. */
export const KITION_KIT_HOST: KitHost = {
  read: async (path) => {
    const response = await fetch(resolveWorkspaceFileURL(path), { cache: 'no-store' })
    if (!response.ok) throw new Error(`could not read ${path} (${response.status})`)
    return { bytes: await response.arrayBuffer(), stamp: stampFromHeaders(response.headers) }
  },
  stamp: async (path) => {
    const response = await fetch(resolveWorkspaceFileURL(path), { method: 'HEAD', cache: 'no-store' })
    return response.ok ? stampFromHeaders(response.headers) : null
  },
  write: async (path, bytes) => {
    await writeKitFile(path, bytes)
  },
  // The workspace file server answers ranged reads; workers need an absolute URL.
  lend: (path) => {
    const root = new URL(resolveWorkspaceFileURL('_').replace(/_$/, ''), window.location.href).href
    return { root, folder: path.split('/').filter(Boolean).slice(0, -1).join('/') }
  },
}
