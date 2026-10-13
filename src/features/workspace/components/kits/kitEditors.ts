import { createElement, lazy, type ComponentType } from 'react'
import { Clapperboard, DraftingCompass, FileText, FileType2, Layers, LayoutTemplate, PenTool, Presentation, Sheet, Sparkles, type LucideIcon } from 'lucide-react'
import { kitSdkAvailable, type EmbeddedKit, type KitSdkManifest } from '@/features/kits/public'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { PhotoKitPane } from '../PhotoKitPane'
import { PHOTO_SDK } from '../photo/photoKitSdk'
import { FilmUnavailable } from '../film/FilmUnavailable'
import { FILM_SDK } from '../film/filmKitSdk'
import { DesignUnavailable } from '../design/DesignUnavailable'
import { DESIGN_SDK } from '../design/designKitSdk'
import { EffectUnavailable } from '../effect/EffectUnavailable'
import { EFFECT_SDK } from '../effect/effectKitSdk'
import { VectorUnavailable } from '../vector/VectorUnavailable'
import { VECTOR_SDK } from '../vector/vectorKitSdk'
import { StandardKitUnavailable } from './StandardKitUnavailable'
import { CAD_KIT, PDF_KIT, SHEET_KIT, SLIDE_KIT, WORD_KIT, type StandardKitSpec } from './standardKits'

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
  /** What the tab shows without the SDK; none for formats the file preview already shows (PDF, Office). */
  Fallback?: ComponentType<KitEditorProps>
  /** The kit's own editor (standard 6.1), shown in an iframe when its package is built in; it wins over `Editor`. */
  embedded?: EmbeddedKit
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

/** A kit on the standard editor (StandardKitEditor), which needs no editor code of its own. */
function standardKit(spec: StandardKitSpec, format: WorkspaceDocumentFormat, options: { create?: KitCreateSpec; preview?: boolean; embedded?: EmbeddedKit } = {}): KitEditorEntry {
  return {
    format,
    sdk: spec.sdk,
    Editor: lazy(() => import('./StandardKitEditor').then((module) => ({ default: (props: KitEditorProps) => createElement(module.StandardKitEditor, { spec, ...props }) }))),
    // A format the file preview shows keeps that preview without the SDK.
    Fallback: options.preview ? undefined : () => createElement(StandardKitUnavailable, { spec }),
    create: options.create,
    embedded: options.embedded,
  }
}

/** The kits' own editors, built by `scripts/build-kit-ui.sh <kit>`. */
const SLIDE_UI: EmbeddedKit = { kitId: 'kit.slide', dir: 'slide-ui' }
const WORD_UI: EmbeddedKit = { kitId: 'kit.word', dir: 'word-ui' }
const SHEET_UI: EmbeddedKit = { kitId: 'kit.sheet', dir: 'sheet-ui' }
const PDF_UI: EmbeddedKit = { kitId: 'kit.pdf', dir: 'pdf-ui' }
const CAD_UI: EmbeddedKit = { kitId: 'kit.cad', dir: 'cad-ui' }
const VECTOR_UI: EmbeddedKit = { kitId: 'kit.vector', dir: 'vector-ui' }
const DESIGN_UI: EmbeddedKit = { kitId: 'kit.design', dir: 'design-ui' }
const PHOTO_UI: EmbeddedKit = { kitId: 'kit.photo', dir: 'photo-ui' }
const EFFECT_UI: EmbeddedKit = { kitId: 'kit.effect', dir: 'effect-ui' }
const FILM_UI: EmbeddedKit = { kitId: 'kit.film', dir: 'film-ui' }

const KIT_EDITORS: readonly KitEditorEntry[] = [
  {
    format: 'photo',
    sdk: PHOTO_SDK,
    Editor: lazy(() => import('../PhotoWebEditor').then((module) => ({ default: module.PhotoWebEditor }))),
    Fallback: PhotoKitPane,
    embedded: PHOTO_UI,
    create: { id: 'image', extension: 'psd', baseName: 'Untitled image', size: { width: 1920, height: 1080 }, label: 'createMenu.format.image', icon: Layers, runtimeFallback: true },
  },
  {
    format: 'film',
    sdk: FILM_SDK,
    Editor: lazy(() => import('../FilmWebEditor').then((module) => ({ default: module.FilmWebEditor }))),
    Fallback: FilmUnavailable,
    embedded: FILM_UI,
    create: { id: 'video', extension: 'fcproj', baseName: 'Untitled video', size: { width: 1920, height: 1080 }, label: 'createMenu.format.video', icon: Clapperboard },
  },
  {
    format: 'vector',
    sdk: VECTOR_SDK,
    Editor: lazy(() => import('../VectorWebEditor').then((module) => ({ default: module.VectorWebEditor }))),
    Fallback: VectorUnavailable,
    embedded: VECTOR_UI,
    create: { id: 'drawing', extension: 'vectorcraft', baseName: 'Untitled drawing', size: { width: 1920, height: 1080 }, label: 'createMenu.format.drawing', icon: PenTool },
  },
  {
    format: 'effect',
    sdk: EFFECT_SDK,
    Editor: lazy(() => import('../EffectWebEditor').then((module) => ({ default: module.EffectWebEditor }))),
    Fallback: EffectUnavailable,
    embedded: EFFECT_UI,
    create: { id: 'motion', extension: 'ecproj', baseName: 'Untitled motion', size: { width: 1920, height: 1080 }, label: 'createMenu.format.motion', icon: Sparkles },
  },
  {
    format: 'layout',
    sdk: DESIGN_SDK,
    Editor: lazy(() => import('../DesignWebEditor').then((module) => ({ default: module.DesignWebEditor }))),
    Fallback: DesignUnavailable,
    embedded: DESIGN_UI,
    // US Letter, in points.
    create: { id: 'layout', extension: 'designcraft', baseName: 'Untitled layout', size: { width: 612, height: 792 }, label: 'createMenu.format.layout', icon: LayoutTemplate },
  },
  // A3 in millimetres; the engine starts a metric drawing with those limits.
  standardKit(CAD_KIT, 'cad', { embedded: CAD_UI, create: { id: 'cad', extension: 'dxf', baseName: 'Untitled CAD drawing', size: { width: 420, height: 297 }, label: 'createMenu.format.cad', icon: DraftingCompass } }),
  standardKit(SLIDE_KIT, 'slide', { embedded: SLIDE_UI, create: { id: 'slide', extension: 'kislide', baseName: 'Untitled slides', size: { width: 960, height: 540 }, label: 'createMenu.format.slide', icon: Presentation } }),
  // PowerPoint files open in the Slides kit, and keep the file preview without it.
  standardKit(SLIDE_KIT, 'pptx', { preview: true, embedded: SLIDE_UI }),
  // Word files open in the Word kit, and keep the file preview without it. US Letter, in points.
  standardKit(WORD_KIT, 'docx', { preview: true, embedded: WORD_UI, create: { id: 'word', extension: 'docx', baseName: 'Untitled Word document', size: { width: 612, height: 792 }, label: 'createMenu.format.word', icon: FileText } }),
  // Excel files open in the Sheet kit, and keep the file preview without it.
  standardKit(SHEET_KIT, 'xlsx', { preview: true, embedded: SHEET_UI, create: { id: 'spreadsheet', extension: 'xlsx', baseName: 'Untitled spreadsheet', size: { width: 1710, height: 2021 }, label: 'createMenu.format.spreadsheet', icon: Sheet } }),
  // PDFs open in the PDF kit, and keep the file preview without it. US Letter, in points.
  standardKit(PDF_KIT, 'pdf', { preview: true, embedded: PDF_UI, create: { id: 'pdf', extension: 'pdf', baseName: 'Untitled PDF', size: { width: 612, height: 792 }, label: 'createMenu.format.pdf', icon: FileType2 } }),
]

const availability = new Map<string, Promise<boolean>>()
const embeddedAvailability = new Map<string, Promise<boolean>>()

/**
 * Whether this build has the kit's own editor: its `kit-ui.json` marker, which a missing package
 * cannot fake (the dev server answers unknown paths with the app's page).
 */
export function embeddedAvailable(entry: KitEditorEntry) {
  const kit = entry.embedded
  if (!kit) return Promise.resolve(false)
  let known = embeddedAvailability.get(kit.dir)
  if (!known) {
    known = fetch(`/kits/${kit.dir}/kit-ui.json`, { cache: 'no-store' })
      .then(async (response) => response.ok && /json/i.test(response.headers.get('content-type') ?? '') && (await response.json()).kitId === kit.kitId)
      .catch(() => false)
    embeddedAvailability.set(kit.dir, known)
  }
  return known
}

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
