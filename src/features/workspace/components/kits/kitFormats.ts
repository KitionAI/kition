/**
 * Every kit's create extension (`psd`, `kvector`, …): the single source `kitEditors.ts` builds
 * its create specs from, and `@/features/workspace/lib/workspace` drops from a workspace tab
 * title (`workspaceTitleExtensionPattern`). A leaf module with no imports of its own, so reading
 * it from `workspace.ts` never cycles back through `@/features/kits/public` — which
 * `kitEditors.ts` needs for `EmbeddedKit`/`KitSdkManifest`, and which the document feature's
 * public surface imports, which `workspace.ts` is read by (`pnpm check:deps`).
 */
export const KIT_CREATE_EXTENSION = {
  photo: 'psd',
  vector: 'kvector',
  design: 'kdesign',
  film: 'kfilm',
  effect: 'keffect',
  cad: 'dxf',
  doc: 'docx',
  sheet: 'xlsx',
  slide: 'kslide',
  pdf: 'pdf',
  table: 'ktable',
  board: 'kboard',
  note: 'md',
} as const

/** Every extension a kit's create menu item makes, for a workspace tab title to drop. */
export function kitCreateExtensions(): string[] {
  return Object.values(KIT_CREATE_EXTENSION)
}
