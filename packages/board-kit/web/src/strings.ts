import type { Catalog } from '@kition/kit-ui'

/** The shell's own strings (`en-US`; kit-ui translates its own). The board editor's are Kition's. */
const enUS: Catalog = {
  openFailed: 'The board could not be opened',
}

export const CATALOGS: Record<string, Catalog> = { 'en-US': enUS }
