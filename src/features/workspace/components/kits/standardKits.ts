import { DraftingCompass, type LucideIcon } from 'lucide-react'
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
  tools?: { initial: string; hidden?: ReadonlySet<string> }
  /** A command-line bar under the canvas that runs the kit's `commandLine` command (CAD). */
  commandLine?: boolean
  /** Where the canvas opens, from `inspect()`: the first page or slide rather than the whole canvas. */
  initialArea?: (inspected: Record<string, unknown>) => RasterRect | null
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
