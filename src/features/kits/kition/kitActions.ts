import { loadDesktopSettings } from '@/services/desktopSettings'
import { restorePortalAccountSession } from '@/services/portalAccount'
import { KitRpcError } from '../host/protocol'

/** A refusal of `host/action` (Kit UI protocol section 7j), with its reason. */
function refuse(reason: string, message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

/**
 * The Settings section `settings.open` shows for `section`: `ai` is wherever the person sets up the
 * model a kit's generation needs (Account while Kition Cloud is the active provider and nobody is
 * signed in, else Models); `models` and `account` name theirs. Anything else is not a kit's to open.
 */
async function settingsSection(section: unknown): Promise<'models' | 'account'> {
  if (section === 'models' || section === 'account') return section
  if (section !== 'ai') refuse('not-allowed', `a kit may not open the Settings section ${JSON.stringify(section)}`)
  const settings = await loadDesktopSettings()
  if (settings.models.activeProvider !== 'kition_console') return 'models'
  return (await restorePortalAccountSession().catch(() => null)) ? 'models' : 'account'
}

/**
 * The host actions Kition serves a kit (Kit UI protocol 2.2 section 7j,
 * capabilities `action:<id>`): `settings.open` (`{ section: 'ai' | 'models' | 'account' }`) opens
 * Settings where the person sets up AI, the next step of a `host/generate` refused as `unavailable`.
 */
export function kitionActions() {
  return {
    'settings.open': async (params: Record<string, unknown>) => {
      const section = await settingsSection(params.section)
      window.dispatchEvent(new CustomEvent('kition:settings:open', { detail: { section } }))
      return { done: true }
    },
  }
}
