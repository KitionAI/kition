// Copied from kition-sdk packages/sdk/kits/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
// Every generated kit (`@kition/sdk/kits`): importing this module registers each kit's schema with
// @kition/sdk, so `openDocument` (and an extension host) works on documents of any of them. The
// typings stay per kit (`@kition/sdk/kits/<kit>`): their type names overlap.
import type { KitDescriptor } from '../kits'
import { boardKit } from './board'
import { cadKit } from './cad'
import { cubeKit } from './cube'
import { effectKit } from './effect'
import { filmKit } from './film'
import { noteKit } from './note'
import { pdfKit } from './pdf'
import { photoKit } from './photo'
import { sheetKit } from './sheet'
import { slideKit } from './slide'
import { tableKit } from './table'
import { vectorKit } from './vector'
import { docKit } from './doc'

export { boardKit, cadKit, cubeKit, effectKit, filmKit, noteKit, pdfKit, photoKit, sheetKit, slideKit, tableKit, vectorKit, docKit }

/** Every generated kit's descriptor, by kit id. */
export const KITS: Readonly<Record<string, KitDescriptor>> = Object.fromEntries(
  [docKit, slideKit, sheetKit, photoKit, vectorKit, effectKit, cadKit, pdfKit, tableKit, filmKit, boardKit, noteKit, cubeKit].map((kit) => [kit.id, kit]),
)
