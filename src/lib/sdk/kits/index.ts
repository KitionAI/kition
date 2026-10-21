// Copied from kition-sdk packages/sdk/kits/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
// Every generated kit (`@kition/sdk/kits`): importing this module registers each kit's schema with
// @kition/sdk, so `openDocument` (and an extension host) works on documents of any of them. The
// typings stay per kit (`@kition/sdk/kits/<kit>`): their type names overlap.
import type { KitDescriptor } from '../kits'
import { boardKit } from './board'
import { cadKit } from './cad'
import { documentKit } from './document'
import { effectKit } from './effect'
import { filmKit } from './film'
import { pdfKit } from './pdf'
import { photoKit } from './photo'
import { sheetKit } from './sheet'
import { slideKit } from './slide'
import { tableKit } from './table'
import { vectorKit } from './vector'
import { wordKit } from './word'

export { boardKit, cadKit, documentKit, effectKit, filmKit, pdfKit, photoKit, sheetKit, slideKit, tableKit, vectorKit, wordKit }

/** Every generated kit's descriptor, by kit id. */
export const KITS: Readonly<Record<string, KitDescriptor>> = Object.fromEntries(
  [wordKit, slideKit, sheetKit, photoKit, vectorKit, effectKit, cadKit, pdfKit, tableKit, filmKit, boardKit, documentKit].map((kit) => [kit.id, kit]),
)
