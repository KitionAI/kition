// The texts Settings > About > Open source licenses shows. Kition's licence and the third-party
// notices (docs/legal/THIRD_PARTY_NOTICES.txt, written by scripts/generate-third-party-notices.mjs)
// are built into the renderer as lazily loaded chunks; each kit's NOTICE and LICENSE are read from
// its package, which the app serves under /kits/<kit>-ui/ (kits/kits.lock.json pins them).

export type BundledKit = { kit: string; version: string; repository: string }

export type KitLicenseTexts = { notice: string | null; license: string | null }

export async function loadKitionLicense(): Promise<string> {
  return (await import('../../../../LICENSE?raw')).default
}

export async function loadThirdPartyNotices(): Promise<string> {
  return (await import('../../../../docs/legal/THIRD_PARTY_NOTICES.txt?raw')).default
}

/** The kits whose packages ship with the app, in the lock's order. */
export async function loadBundledKits(): Promise<BundledKit[]> {
  const lock: Record<string, unknown> = (await import('../../../../kits/kits.lock.json')).default
  return Object.entries(lock)
    .filter(([kit]) => !kit.startsWith('$'))
    .map(([kit, entry]) => {
      const { version, repository } = entry as { version: string; repository: string }
      return { kit, version, repository }
    })
}

/**
 * A text file of a kit package, or null when this build has no such file. A development server
 * answers a missing path with the app's page, so an HTML answer counts as missing too.
 */
async function readKitFile(kit: string, name: 'NOTICE' | 'LICENSE'): Promise<string | null> {
  const response = await fetch(`/kits/${kit}-ui/${name}`)
  if (!response.ok || /html/i.test(response.headers.get('content-type') ?? '')) return null
  const text = await response.text()
  return /^\s*<!doctype html/i.test(text) ? null : text
}

export async function loadKitLicenseTexts(kit: string): Promise<KitLicenseTexts> {
  const [notice, license] = await Promise.all([readKitFile(kit, 'NOTICE'), readKitFile(kit, 'LICENSE')])
  return { notice, license }
}
