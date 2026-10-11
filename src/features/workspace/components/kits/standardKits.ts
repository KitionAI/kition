import { DraftingCompass, FileText, Presentation, type LucideIcon } from 'lucide-react'
import type { KitSdkManifest, RasterRect } from '@/features/kits/public'

/**
 * A kit whose editor is the standard one: menus from its commands, its engine's tools on the
 * rail, the canvas, and a status line from its `inspect()`. Strings live under `<key>Kit` in the
 * workspace strings: `summary` (filled from `summary` below) and any menu names that the shared
 * `kitEditor.menu` names do not cover.
 */
export type StandardKitSpec = {
  sdk: KitSdkManifest
  /** Test ids (`<key>-status`, `<key>-tool-...`) and the string namespace `<key>Kit`. */
  key: string
  icon: LucideIcon
  /** Top-level menus in display order (the kit's `kit.json` `ui.menus`). */
  menuOrder: readonly string[]
  /** The engine's tools (engine-tools capability): the first one, and any kept off the rail. */
  tools?: { initial: string; hidden?: ReadonlySet<string>; rail?: boolean }
  /** A command-line bar under the canvas that runs the kit's `commandLine` command (CAD). */
  commandLine?: boolean
  /** Where the canvas opens, from `inspect()`: the first page or slide rather than the whole canvas. */
  initialArea?: (inspected: Record<string, unknown>) => RasterRect | null
  /** The current page or slide; the canvas brings it into view when it changes and is mostly offscreen. */
  focusArea?: (inspected: Record<string, unknown>) => RasterRect | null
  /** The `<key>Kit.summary` values for the status line, from the engine's `inspect()`. */
  summary: (inspected: Record<string, unknown>) => Record<string, string | number> | null
}

const count = (value: unknown) => (typeof value === 'number' ? value : 0)

/** The CAD engine (`kition-cad-sdk` in the kit-cad repository), built by `scripts/build-kit-sdk.sh cad`. */
export const CAD_KIT: StandardKitSpec = {
  sdk: { kitId: 'kit.cad', dir: 'cad-sdk', module: 'kition_cad_sdk', documentClass: 'CadDocument' },
  key: 'cad',
  icon: DraftingCompass,
  menuOrder: ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Draw', 'Dimension', 'Modify'],
  tools: { initial: 'select' },
  commandLine: true,
  summary: (inspected) => ({
    objects: count(inspected.entities),
    selected: count(inspected.selection),
    layer: typeof inspected.currentLayer === 'string' ? inspected.currentLayer : '0',
  }),
}

type InspectedArea = { x: number; y: number; width: number; height: number }

/** A slide's or page's `{x, y, width, height}` from `inspect()` (under `key`) as a canvas rectangle. */
function slideArea(inspected: Record<string, unknown>, index: number, key = 'slides'): RasterRect | null {
  const area = (inspected[key] as Array<{ area?: InspectedArea }> | undefined)?.[index]?.area
  return area ? { x0: area.x, y0: area.y, x1: area.x + area.width, y1: area.y + area.height } : null
}

/** The Presentation engine (`kition-presentation-sdk` in the kit-presentation repository), built by `scripts/build-kit-sdk.sh presentation`. */
export const PRESENTATION_KIT: StandardKitSpec = {
  sdk: { kitId: 'kit.presentation', dir: 'presentation-sdk', module: 'kition_presentation_sdk', documentClass: 'PresentationDocument' },
  key: 'presentation',
  icon: Presentation,
  menuOrder: ['File', 'Edit', 'Home', 'Insert', 'Design', 'Transitions', 'Animations', 'Slide Show', 'Review', 'View', 'Arrange', 'Format', 'Shape Format', 'Picture Format', 'Table Design', 'Table Layout', 'Chart Design', 'Slide Master', 'Window'],
  tools: { initial: 'select' },
  // The slides are stacked on one canvas; open on the first.
  initialArea: (inspected) => slideArea(inspected, 0),
  focusArea: (inspected) => slideArea(inspected, count(inspected.slide)),
  summary: (inspected) => ({
    slide: count(inspected.slide) + 1,
    slides: Array.isArray(inspected.slides) ? inspected.slides.length : 0,
    selected: count(inspected.selection),
  }),
}

/** The Word engine (`kition-word-sdk` in the kit-word repository), built by `scripts/build-kit-sdk.sh word`. */
export const WORD_KIT: StandardKitSpec = {
  sdk: { kitId: 'kit.word', dir: 'word-sdk', module: 'kition_word_sdk', documentClass: 'WordDocument' },
  key: 'word',
  icon: FileText,
  menuOrder: ['File', 'Home', 'Insert', 'Draw', 'Design', 'Layout', 'References', 'Mailings', 'Review', 'View', 'Table Design', 'Table Layout', 'Picture Format', 'Shape Format', 'Header & Footer', 'Equation'],
  // One text tool (click, drag, type), so no rail.
  tools: { initial: 'text', rail: false },
  initialArea: (inspected) => slideArea(inspected, 0, 'pages'),
  focusArea: (inspected) => slideArea(inspected, count(inspected.page), 'pages'),
  summary: (inspected) => ({
    page: count(inspected.page) + 1,
    pages: Array.isArray(inspected.pages) ? inspected.pages.length : 0,
    words: count(inspected.words),
  }),
}
