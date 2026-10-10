import { KitEngine } from './kitEngine'
import type { KitHost } from './kitHost'
import type { KitSdkManifest } from './kitSdk'

/**
 * Makes a new file with a kit's SDK: an empty document of the given size,
 * saved and written to `path` through the host. No kit process is involved.
 */
export async function createKitFile(host: KitHost, manifest: KitSdkManifest, path: string, size: { width: number; height: number }) {
  const name = path.split('/').filter(Boolean).pop() || path
  const engine = await KitEngine.create(manifest, name, size.width, size.height)
  try {
    await host.write(path, await engine.save())
  } finally {
    engine.dispose()
  }
}
