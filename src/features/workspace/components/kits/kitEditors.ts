import { lazy, type ComponentType } from 'react'
import { Clapperboard, Layers, type LucideIcon } from 'lucide-react'
import { kitSdkAvailable, type KitSdkManifest } from '@/features/kits/public'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { PhotoKitPane } from '../PhotoKitPane'
import { PHOTO_SDK } from '../photo/photoKitSdk'
import { FilmUnavailable } from '../film/FilmUnavailable'
import { FILM_SDK } from '../film/filmKitSdk'

/** What every kit editor receives from the workspace tab. */
export type KitEditorProps = {
  path: string
  /** The tab is in front. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * One kit in the workspace: the file format it opens (from the desktop
 * format table, src-tauri/src/workspace/formats.rs), its SDK, the in-page
 * editor used when the SDK is built into the app, and what the tab shows
 * otherwise. Adding a kit adds one entry here; see docs/kit-sdk.md.
 */
export type KitEditorEntry = {
  format: WorkspaceDocumentFormat
  sdk: KitSdkManifest
  Editor: ComponentType<KitEditorProps>
  Fallback: ComponentType<KitEditorProps>
  /** A create menu item: an empty document of this size, made by the SDK in the page. */
  create?: KitCreateSpec
}

export type KitCreateSpec = {
  /** The menu item's test id is `workspace-create-<id>`. */
  id: string
  extension: string
  /** The new file is `<baseName>.<extension>`, numbered when that exists. */
  baseName: string
  size: { width: number; height: number }
  /** A key in the workspace strings. */
  label: string
  icon: LucideIcon
  /** Without the SDK, the runtime's kit process can create it (`POST /v1/kits/documents/new`). */
  runtimeFallback?: boolean
}

const KIT_EDITORS: readonly KitEditorEntry[] = [
  {
    format: 'photo',
    sdk: PHOTO_SDK,
    Editor: lazy(() => import('../PhotoWebEditor').then((module) => ({ default: module.PhotoWebEditor }))),
    Fallback: PhotoKitPane,
    create: { id: 'image', extension: 'psd', baseName: 'Untitled image', size: { width: 1920, height: 1080 }, label: 'createMenu.format.image', icon: Layers, runtimeFallback: true },
  },
  {
    format: 'film',
    sdk: FILM_SDK,
    Editor: lazy(() => import('../FilmWebEditor').then((module) => ({ default: module.FilmWebEditor }))),
    Fallback: FilmUnavailable,
    create: { id: 'video', extension: 'fcproj', baseName: 'Untitled video', size: { width: 1920, height: 1080 }, label: 'createMenu.format.video', icon: Clapperboard },
  },
]

const availability = new Map<string, Promise<boolean>>()

/** Whether this build has the kit's SDK; asked once per kit. */
export function sdkAvailable(entry: KitEditorEntry) {
  let known = availability.get(entry.sdk.kitId)
  if (!known) {
    known = kitSdkAvailable(entry.sdk)
    availability.set(entry.sdk.kitId, known)
  }
  return known
}

/** Every kit that offers a create menu item. */
export function creatableKits() {
  return KIT_EDITORS.filter((entry): entry is KitEditorEntry & { create: KitCreateSpec } => Boolean(entry.create))
}

export function kitEditorFor(format: WorkspaceDocumentFormat) {
  return KIT_EDITORS.find((entry) => entry.format === format)
}
