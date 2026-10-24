import type { KitIconId } from '@/components/KitIcon'
import type { EmbeddedKit, KitSdkManifest } from '@/features/kits/public'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { KIT_CREATE_EXTENSION } from './kitFormats'

/** What every kit editor receives from the workspace tab. */
export type KitEditorProps = {
  path: string
  /** The tab is in front. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * One kit in the workspace: the file format it opens (from the desktop format table,
 * src-tauri/src/workspace/formats.rs) and the kit's package, which release builds always
 * include (`scripts/build-kits.sh`). The package holds the kit's own editor, shown in an
 * iframe (standard 6.1), and its engine, which Kition also uses to make new files.
 * Adding a kit adds one entry here; see docs/kit-sdk.md.
 */
export type KitEditorEntry = {
  format: WorkspaceDocumentFormat
  /** The kit's package under `public/kits/<dir>/`. */
  embedded: EmbeddedKit
  /** The kit's engine inside its package. */
  engine: KitSdkManifest
  /** The `<key>Kit` strings and the kit icon. */
  key: string
  icon: KitIconId
  /** The file preview shows this format, and keeps showing it in a build without the kit. */
  preview?: boolean
  /** A create menu item: an empty document of this size, made by the kit's engine in the page. */
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
  /** The create menu's group the item is in. */
  group: KitCreateGroup
}

/** The create menu's groups, by what the new file is for, not by who makes it. */
export type KitCreateGroup = 'documents' | 'data' | 'visual' | 'media'

/** A kit packaged by `scripts/build-kit-ui.sh <kit>` into `public/kits/<kit>-ui/`. */
function kit(name: string, documentClass: string, entry: Omit<KitEditorEntry, 'embedded' | 'engine' | 'key'> & { key?: string }): KitEditorEntry {
  const dir = `${name}-ui`
  return {
    ...entry,
    key: entry.key ?? name,
    embedded: { kitId: `kit.${name}`, dir },
    engine: { kitId: `kit.${name}`, dir: `${dir}/engine`, module: `kition_${name}_sdk`, documentClass },
  }
}

// The create menu orders its items itself (`CREATE_ORDER` in `WorkspaceCreateMenu`).
const KIT_EDITORS: readonly KitEditorEntry[] = [
  kit('photo', 'PhotoDocument', { format: 'photo', icon: 'photo', create: { id: 'photo', extension: KIT_CREATE_EXTENSION.photo, baseName: 'Untitled photo', size: { width: 1920, height: 1080 }, label: 'createMenu.format.photo', group: 'visual' } }),
  kit('vector', 'VectorDocument', { format: 'vector', icon: 'vector', create: { id: 'vector', extension: KIT_CREATE_EXTENSION.vector, baseName: 'Untitled vector', size: { width: 1920, height: 1080 }, label: 'createMenu.format.vector', group: 'visual' } }),
  // US Letter, in points.
  kit('design', 'DesignDocument', { format: 'layout', icon: 'layout', create: { id: 'layout', extension: KIT_CREATE_EXTENSION.design, baseName: 'Untitled design', size: { width: 612, height: 792 }, label: 'createMenu.format.layout', group: 'documents' } }),
  kit('film', 'FilmDocument', { format: 'film', icon: 'film', create: { id: 'video', extension: KIT_CREATE_EXTENSION.film, baseName: 'Untitled film', size: { width: 1920, height: 1080 }, label: 'createMenu.format.video', group: 'media' } }),
  kit('effect', 'EffectDocument', { format: 'effect', icon: 'effect', create: { id: 'effect', extension: KIT_CREATE_EXTENSION.effect, baseName: 'Untitled effect', size: { width: 1920, height: 1080 }, label: 'createMenu.format.effect', group: 'media' } }),
  // A3 in millimetres; the engine starts a metric drawing with those limits.
  kit('cad', 'CadDocument', { format: 'cad', icon: 'cad', create: { id: 'cad', extension: KIT_CREATE_EXTENSION.cad, baseName: 'Untitled CAD', size: { width: 420, height: 297 }, label: 'createMenu.format.cad', group: 'visual' } }),
  // US Letter, in points.
  kit('word', 'WordDocument', { format: 'docx', icon: 'word', preview: true, create: { id: 'word', extension: KIT_CREATE_EXTENSION.word, baseName: 'Untitled document', size: { width: 612, height: 792 }, label: 'createMenu.format.word', group: 'documents' } }),
  kit('sheet', 'SheetDocument', { format: 'xlsx', icon: 'sheet', preview: true, create: { id: 'sheet', extension: KIT_CREATE_EXTENSION.sheet, baseName: 'Untitled sheet', size: { width: 1710, height: 2021 }, label: 'createMenu.format.sheet', group: 'data' } }),
  kit('slide', 'SlideDocument', { format: 'slide', icon: 'slide', create: { id: 'slide', extension: KIT_CREATE_EXTENSION.slide, baseName: 'Untitled slide', size: { width: 960, height: 540 }, label: 'createMenu.format.slide', group: 'visual' } }),
  // PowerPoint files open in the Slide kit.
  kit('slide', 'SlideDocument', { format: 'pptx', icon: 'slide', preview: true }),
  // US Letter, in points.
  kit('pdf', 'PdfDocument', { format: 'pdf', icon: 'pdf', preview: true, create: { id: 'pdf', extension: KIT_CREATE_EXTENSION.pdf, baseName: 'Untitled PDF', size: { width: 612, height: 792 }, label: 'createMenu.format.pdf', group: 'documents' } }),
  // Kition's host features (workflows, form and email sync) reach a table's records through the kit too.
  kit('table', 'TableDocument', { format: 'table', icon: 'table', create: { id: 'table', extension: KIT_CREATE_EXTENSION.table, baseName: 'Untitled table', size: { width: 640, height: 420 }, label: 'createMenu.format.table', group: 'data' } }),
  kit('board', 'BoardDocument', { format: 'board', icon: 'board', create: { id: 'board', extension: KIT_CREATE_EXTENSION.board, baseName: 'Untitled board', size: { width: 1920, height: 1080 }, label: 'createMenu.format.board', group: 'visual' } }),
  // Markdown notes (`.md`, `.markdown`); US Letter, in points, for its pages.
  kit('note', 'NoteDocument', { format: 'markdown', icon: 'note', create: { id: 'note', extension: KIT_CREATE_EXTENSION.note, baseName: 'Untitled note', size: { width: 612, height: 792 }, label: 'createMenu.format.note', group: 'documents' } }),
]

const availability = new Map<string, Promise<boolean>>()

/**
 * Whether this build includes the kit's package: its `kit-ui.json` marker, which a missing
 * package cannot fake (the dev server answers unknown paths with the app's page). Release
 * builds always do; a development build has the kits `make kit-uis` built.
 */
export function kitAvailable(entry: KitEditorEntry) {
  const { dir, kitId } = entry.embedded
  let known = availability.get(dir)
  if (!known) {
    known = fetch(`/kits/${dir}/kit-ui.json`, { cache: 'no-store' })
      .then(async (response) => response.ok && /json/i.test(response.headers.get('content-type') ?? '') && (await response.json()).kitId === kitId)
      .catch(() => false)
    availability.set(dir, known)
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

/** The kit `kitId` as co-editing opens a document shared with this person: its engine, and its file extension. */
export function sharedKitFor(kitId: string) {
  const entry = creatableKits().find((candidate) => candidate.embedded.kitId === kitId)
  return entry ? { engine: entry.engine, extension: entry.create.extension } : null
}

/** The package of the kit `kitId` (its editor), as the version history shows a kit document's past versions. */
export function embeddedKitFor(kitId: string) {
  return KIT_EDITORS.find((entry) => entry.embedded.kitId === kitId)?.embedded ?? null
}
