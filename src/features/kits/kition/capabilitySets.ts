import { advertiseCapabilitySets } from '@kition/sdk/script'

/**
 * The Kition kit platform's capability sets Kition serves (kition-sdk `docs/platform/index.md` section 3): the KDM replica of
 * every contract 2 kit, the object model, and extensions (Kition Desktop is single-user: no `KitCollab`). Kits
 * get them in `ui/initialize` (`capabilitySets`); scripts in the page test them with `supports`.
 */
export const KITION_CAPABILITY_SETS = ['KitModel 1.1', 'KitObjectModel 1.0', 'KitExtensions 1.0']

advertiseCapabilitySets(KITION_CAPABILITY_SETS)
