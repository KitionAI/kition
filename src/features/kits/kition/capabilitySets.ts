import { advertiseCapabilitySets } from '@/lib/sdk'

/**
 * The Kition kit platform's capability sets Kition serves (kition-sdk `docs/platform/index.md` section 3): the KDM replica of
 * every contract 2 kit, co-editing through a sync server with comments and sync across a person's
 * devices, the object model, and extensions. Kits
 * get them in `ui/initialize` (`capabilitySets`); scripts in the page test them with `supports`.
 */
export const KITION_CAPABILITY_SETS = ['KitModel 1.1', 'KitCollab 1.2', 'KitObjectModel 1.0', 'KitExtensions 1.0']

advertiseCapabilitySets(KITION_CAPABILITY_SETS)
