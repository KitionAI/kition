import type { KitEngineInfo, KitSdkManifest, RasterRect } from '@/features/kits/public'

/** The Design engine (`kition-design-sdk` in the kit-design repository), built by `scripts/build-kit-sdk.sh design`. */
export const DESIGN_SDK: KitSdkManifest = {
  kitId: 'kit.design',
  dir: 'design-sdk',
  module: 'kition_design_sdk',
  documentClass: 'DesignDocument',
}

/** One spread on the canvas: where it is (document pixels) and its pages' names. */
type DesignSpread = { index: number; area: RasterRect; pages: string[] }

/** What the Design editor shows about the open layout. */
export type DesignState = {
  title: string
  spreads: DesignSpread[]
  pageCount: number
  stories: number
  selected: number
  /** Text is being edited (a caret or a text selection). */
  editingText: boolean
}

type Inspected = {
  title?: string
  pageCount?: number
  stories?: unknown[]
  spreads?: Array<{ index?: number; pages?: Array<{ name?: string }> }>
  canvas?: { spreads?: Array<{ x: number; y: number; width: number; height: number }> }
  selection?: { items?: unknown[]; text?: unknown }
}

/** Reads the spreads, their pages and places on the canvas, and the selection from the engine's inspect JSON. */
export function describeDesign(info: KitEngineInfo): DesignState {
  const inspected = info.inspected as Inspected
  const placed = inspected.canvas?.spreads ?? []
  return {
    title: inspected.title ?? '',
    spreads: (inspected.spreads ?? []).map((spread, index) => {
      const at = placed[index] ?? { x: 0, y: 0, width: info.width, height: info.height }
      return {
        index: spread.index ?? index,
        area: { x0: at.x, y0: at.y, x1: at.x + at.width, y1: at.y + at.height },
        pages: (spread.pages ?? []).map((page) => page.name ?? ''),
      }
    }),
    pageCount: inspected.pageCount ?? 0,
    stories: inspected.stories?.length ?? 0,
    selected: inspected.selection?.items?.length ?? 0,
    editingText: inspected.selection?.text != null,
  }
}
