// Copied from kition-sdk packages/sdk/kits/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
// Every generated kit (`@kition/sdk/kits`): importing this module registers each kit's schema with
// @kition/sdk, so `openDocument` (and an extension host) works on documents of any of them. The
// typings stay per kit (`@kition/sdk/kits/<kit>`): their type names overlap.
import type { KitDescriptor } from '../kits'
import { cadKit } from './cad'
import { effectKit } from './effect'
import { filmKit } from './film'
import { pdfKit } from './pdf'
import { photoKit } from './photo'
import { sheetsKit } from './sheet'
import { slidesKit } from './slide'
import { tableKit } from './table'
import { vectorKit } from './vector'
import { wordKit } from './word'

export { cadKit, effectKit, filmKit, pdfKit, photoKit, sheetsKit, slidesKit, tableKit, vectorKit, wordKit }

/** Every generated kit's descriptor, by kit id. */
export const KITS: Readonly<Record<string, KitDescriptor>> = Object.fromEntries(
  [wordKit, slidesKit, sheetsKit, photoKit, vectorKit, effectKit, cadKit, pdfKit, tableKit, filmKit].map((kit) => [kit.id, kit]),
)
