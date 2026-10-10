import {
  Bandage,
  Blend,
  Brush,
  Crop,
  Droplet,
  Eraser,
  Hand,
  History,
  Lasso,
  MousePointer2,
  Move,
  PaintBucket,
  PenTool,
  Pipette,
  Square,
  SquareDashed,
  Stamp,
  Sun,
  Type,
  WandSparkles,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'

/** A tool on the Photo tool rail; `id` is the editor's tool name. */
export type PhotoTool = {
  id: string
  icon: LucideIcon
  /** Key under `photoKit.tools` in the workspace strings. */
  label: string
  shortcut: string
  /** Paints with the brush, so the options bar shows the brush size. */
  painting?: boolean
}

export const PHOTO_TOOLS: readonly PhotoTool[] = [
  { id: 'Move', icon: Move, label: 'move', shortcut: 'V' },
  { id: 'RectMarquee', icon: SquareDashed, label: 'marquee', shortcut: 'M' },
  { id: 'Lasso', icon: Lasso, label: 'lasso', shortcut: 'L' },
  { id: 'MagicWand', icon: WandSparkles, label: 'magicWand', shortcut: 'W' },
  { id: 'Crop', icon: Crop, label: 'crop', shortcut: 'C' },
  { id: 'Eyedropper', icon: Pipette, label: 'eyedropper', shortcut: 'I' },
  { id: 'SpotHealing', icon: Bandage, label: 'healing', shortcut: 'J', painting: true },
  { id: 'Brush', icon: Brush, label: 'brush', shortcut: 'B', painting: true },
  { id: 'CloneStamp', icon: Stamp, label: 'cloneStamp', shortcut: 'S', painting: true },
  { id: 'HistoryBrush', icon: History, label: 'historyBrush', shortcut: 'Y', painting: true },
  { id: 'Eraser', icon: Eraser, label: 'eraser', shortcut: 'E', painting: true },
  { id: 'Gradient', icon: Blend, label: 'gradient', shortcut: 'G' },
  { id: 'PaintBucket', icon: PaintBucket, label: 'paintBucket', shortcut: 'G' },
  { id: 'Blur', icon: Droplet, label: 'blur', shortcut: 'R', painting: true },
  { id: 'Dodge', icon: Sun, label: 'dodge', shortcut: 'O', painting: true },
  { id: 'Pen', icon: PenTool, label: 'pen', shortcut: 'P' },
  { id: 'Type', icon: Type, label: 'type', shortcut: 'T' },
  { id: 'PathSelection', icon: MousePointer2, label: 'pathSelection', shortcut: 'A' },
  { id: 'Rectangle', icon: Square, label: 'shape', shortcut: 'U' },
  { id: 'Hand', icon: Hand, label: 'hand', shortcut: 'H' },
  { id: 'Zoom', icon: ZoomIn, label: 'zoom', shortcut: 'Z' },
]

/** The menus the editor offers, in the order desktop image editors show them. */
export const PHOTO_MENU_ORDER = ['File', 'Edit', 'Image', 'Layer', 'Type', 'Select', 'Filter', 'View', 'Window', 'Help'] as const

export function toolFor(id: string | null | undefined) {
  return PHOTO_TOOLS.find((tool) => tool.id === id)
}

/** An RGBA colour with 0 to 1 channels, as CSS. */
export function cssColor(color: readonly number[] | null | undefined) {
  if (!color || color.length < 3) return 'transparent'
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255)
  return `rgb(${channel(color[0])} ${channel(color[1])} ${channel(color[2])})`
}
