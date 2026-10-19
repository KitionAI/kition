import type { Catalog } from '@kition/kit-ui'

/** The shell's own strings (`en-US`; kit-ui translates its own). The editor's are Kition's. */
const enUS: Catalog = {
  openFailed: 'The document could not be opened',
}

export const CATALOGS: Record<string, Catalog> = { 'en-US': enUS }
