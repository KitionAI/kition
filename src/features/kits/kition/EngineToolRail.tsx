import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Blend,
  Columns2,
  File,
  Package,
  Palette,
  StickyNote,
  Brush,
  Circle,
  Crop,
  Eraser,
  Frame,
  Grid3x3,
  Hand,
  Lasso,
  Minus,
  MousePointer,
  MousePointer2,
  PaintBucket,
  Pencil,
  PenTool,
  Pipette,
  Ruler,
  Scaling,
  Scissors,
  Shapes,
  Spline,
  Square,
  RotateCw,
  Type,
  Wand2,
  Waves,
  Move3d,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { ActionMenu, ActionMenuContent, ActionMenuItem, ActionMenuTrigger } from '@/components/ActionMenu'
import type { EngineToolInfo } from '../sdk/engineTools'
import { cn } from '@/lib/utils'

/**
 * Kition's icon for an engine tool icon name. The Craft engines name their icons `tool-<kind>`;
 * a kit with other names gets the generic icon until they are added here.
 */
const ICONS: Array<[RegExp, LucideIcon]> = [
  [/^tool-selection$/, MousePointer2],
  [/^tool-page$/, File],
  [/^tool-gap$/, Columns2],
  [/^tool-(collector|placer)/, Package],
  [/^tool-(rect-frame|ellipse-frame|polygon-frame)/, Frame],
  [/^tool-note/, StickyNote],
  [/^tool-color-theme/, Palette],
  [/^tool-gradient-feather/, Blend],
  [/^tool-(direct|group-select|live-select|perspective-select)/, MousePointer],
  [/^tool-magic-wand/, Wand2],
  [/^tool-lasso/, Lasso],
  [/^tool-(pen|anchor)/, PenTool],
  [/^tool-curvature/, Spline],
  [/^tool-(type|touch-type)/, Type],
  [/^tool-(line|arc|spiral)/, Minus],
  [/^tool-(rect-grid|polar-grid|perspective)/, Grid3x3],
  [/^tool-(rect|rounded-rect|polygon|star|flare)/, Square],
  [/^tool-ellipse/, Circle],
  [/^tool-(brush|blob-brush)/, Brush],
  [/^tool-(pencil|smooth|shaper|join|path-eraser)/, Pencil],
  [/^tool-eraser/, Eraser],
  [/^tool-(scissors|knife|mirror-cut|line-cut|rect-cut)/, Scissors],
  [/^tool-(rotate|reflect)/, RotateCw],
  [/^tool-(scale|shear|reshape|free-transform|puppet)/, Scaling],
  [/^tool-(width|warp|twirl|pucker|bloat|scallop|crystallize|wrinkle)/, Waves],
  [/^tool-shape-builder/, Shapes],
  [/^tool-bucket/, PaintBucket],
  [/^tool-mesh/, Move3d],
  [/^tool-gradient/, Blend],
  [/^tool-eyedropper/, Pipette],
  [/^tool-measure/, Ruler],
  [/^tool-blend/, Blend],
  [/^tool-artboard/, Frame],
  [/^tool-slice/, Crop],
  [/^tool-hand/, Hand],
  [/^tool-zoom/, ZoomIn],
]

function iconFor(tool: EngineToolInfo) {
  return ICONS.find(([pattern]) => pattern.test(tool.icon))?.[1] ?? Shapes
}

type EngineToolRailProps = {
  tools: readonly EngineToolInfo[]
  active: string
  onSelect: (id: string) => void
  /** Test ids are `<testId>-tool-<id>`, `<testId>-tool-group-<n>`, and `<testId>-tool-item-<id>`. */
  testId: string
}

/**
 * A kit engine's tools (the engine-tools capability), one slot per group as in
 * Adobe's apps: the slot shows the group's last-used tool, and right-click (or
 * the corner mark) lists the rest of the group.
 */
export function EngineToolRail({ tools, active, onSelect, testId }: EngineToolRailProps) {
  const { t } = useTranslation('workspace')
  const [chosen, setChosen] = useState<Record<number, string>>({})
  const [open, setOpen] = useState<number | null>(null)
  const groups = new Map<number, EngineToolInfo[]>()
  for (const tool of tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool])

  const select = (tool: EngineToolInfo) => {
    setChosen((current) => ({ ...current, [tool.group]: tool.id }))
    onSelect(tool.id)
  }

  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border py-2" role="toolbar" aria-orientation="vertical" aria-label={t('kitEditor.tools')} data-testid={`${testId}-tool-rail`}>
      {[...groups.entries()].map(([group, members]) => {
        const shown = members.find((tool) => tool.id === active) ?? members.find((tool) => tool.id === chosen[group]) ?? members[0]
        const Icon = iconFor(shown)
        const isActive = members.some((tool) => tool.id === active)
        const label = shown.shortcut ? `${shown.label} (${shown.shortcut})` : shown.label
        return (
          <ActionMenu key={group} open={open === group} onOpenChange={(next) => setOpen(next ? group : null)}>
            <div className="relative">
              <button
                type="button"
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors',
                  'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                  isActive && 'bg-accent text-accent-foreground',
                )}
                aria-label={label}
                aria-pressed={isActive}
                title={label}
                onClick={() => select(shown)}
                onContextMenu={(event) => {
                  if (members.length < 2) return
                  event.preventDefault()
                  setOpen(group)
                }}
                data-testid={`${testId}-tool-${shown.id}`}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
              {members.length > 1 ? (
                <ActionMenuTrigger asChild>
                  <button
                    type="button"
                    className="absolute bottom-0.5 right-0.5 size-0 border-b-[4px] border-l-[4px] border-b-muted-foreground/70 border-l-transparent outline-none"
                    aria-label={t('kitEditor.moreTools', { tool: shown.label })}
                    data-testid={`${testId}-tool-group-${group}`}
                  />
                </ActionMenuTrigger>
              ) : null}
            </div>
            <ActionMenuContent side="right" align="start" className="min-w-52">
              {members.map((tool) => {
                const ToolIcon = iconFor(tool)
                return (
                  <ActionMenuItem key={tool.id} onSelect={() => select(tool)} data-testid={`${testId}-tool-item-${tool.id}`}>
                    <ToolIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">{tool.label}</span>
                    {tool.shortcut ? <span className="text-xs text-muted-foreground">{tool.shortcut}</span> : null}
                  </ActionMenuItem>
                )
              })}
            </ActionMenuContent>
          </ActionMenu>
        )
      })}
    </div>
  )
}
