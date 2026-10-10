import { lazy, type ComponentType } from 'react'
import type { KitSdkManifest } from '@/features/kits/public'
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
}

const KIT_EDITORS: readonly KitEditorEntry[] = [
  {
    format: 'photo',
    sdk: PHOTO_SDK,
    Editor: lazy(() => import('../PhotoWebEditor').then((module) => ({ default: module.PhotoWebEditor }))),
    Fallback: PhotoKitPane,
  },
  {
    format: 'film',
    sdk: FILM_SDK,
    Editor: lazy(() => import('../FilmWebEditor').then((module) => ({ default: module.FilmWebEditor }))),
    Fallback: FilmUnavailable,
  },
]

export function kitEditorFor(format: WorkspaceDocumentFormat) {
  return KIT_EDITORS.find((entry) => entry.format === format)
}
