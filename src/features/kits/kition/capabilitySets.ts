import { advertiseCapabilitySets } from '@/lib/sdk'

/**
 * The Kit Standard 2.0 capability sets Kition serves (standard-2 section 10): the KDM replica of
 * every contract 2 kit, co-editing through a sync server, the object model, and extensions. Kits
 * get them in `ui/initialize` (`capabilitySets`); scripts in the page test them with `supports`.
 */
export const KITION_CAPABILITY_SETS = ['KitModel 1.0', 'KitCollab 1.0', 'KitObjectModel 1.0', 'KitExtensions 1.0']

advertiseCapabilitySets(KITION_CAPABILITY_SETS)
