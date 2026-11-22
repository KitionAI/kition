import menu from '../../../../../kits/menu.json'
import type { KitIconId } from '@/components/KitIcon'
import { kitById, kitByName, kitCatalog, type KitCatalogEntry, type KitCreate } from '@/lib/kitCatalog'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { kitForWorkspaceFormat } from '@/services/workspaceFormats'

/** What every kit editor receives from the workspace tab. */
export type KitEditorProps = {
  path: string
  /** The tab is in front. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * One kit in the workspace, from the kit catalog (the manifests of this build's kit packages,
 * `src/lib/kitCatalog.ts`): the kit's package, which holds its own editor,
 * shown in an iframe (standard 6.1), and its engine, which Kition also uses to make new files.
 * No kit is registered here: a kit that ships (`kits/kits.lock.json`) and whose package is in the
 * build is in the workspace; see docs/kits.md.
 */
export type KitEditorEntry = KitCatalogEntry & {
  /** The `<key>Kit` strings and the kit icon: the kit's name. */
  key: string
  icon: KitIconId
}

export type KitCreateSpec = KitCreate & {
  /** A key in the workspace strings. */
  label: string
  /** The create menu's group the item is in. */
  group: KitCreateGroup
}

/** The create menu's groups (`kits/menu.json`), by what the new file is for, not by who makes it. */
export type KitCreateGroup = string

function editor(entry: KitCatalogEntry): KitEditorEntry {
  return { ...entry, key: entry.name, icon: entry.name }
}

/** The create menu's groups, in menu order. */
export function kitCreateGroups(): KitCreateGroup[] {
  return menu.create.map((each) => each.group)
}

/**
 * Every kit of this build that has a create menu item, in menu order (`kits/menu.json`): the item
 * makes the first document type the kit's manifest creates.
 */
export function creatableKits(): (KitEditorEntry & { create: KitCreateSpec })[] {
  return menu.create.flatMap(({ group, kits }) =>
    kits.flatMap((name) => {
      const entry = kitByName(name)
      const create = entry?.creates[0]
      return entry && create ? [{ ...editor(entry), create: { ...create, label: `createMenu.format.${create.id}`, group } }] : []
    }),
  )
}

/** The kit whose editor shows files of `format`, when this build has one. */
export function kitEditorFor(format: WorkspaceDocumentFormat) {
  const entry = kitForWorkspaceFormat(format)
  return entry ? editor(entry) : undefined
}

/** The kit `kitId` as co-editing opens a document shared with this person: its engine, and its file extension. */
export function sharedKitFor(kitId: string) {
  const entry = kitById(kitId)
  const create = entry?.creates[0]
  return entry && create ? { engine: entry.engine, extension: create.extension } : null
}

/** The package of the kit `kitId` (its editor), as the version history shows a kit document's past versions. */
export function embeddedKitFor(kitId: string) {
  return kitById(kitId)?.embedded ?? null
}

/** Every extension a kit of this build creates, for a workspace tab title to drop. */
export function kitCreateExtensions(): string[] {
  return kitCatalog().flatMap((entry) => entry.creates.map((create) => create.extension))
}
