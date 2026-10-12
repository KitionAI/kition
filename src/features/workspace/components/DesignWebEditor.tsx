import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutTemplate } from 'lucide-react'
import {
  EngineToolRail,
  HAND_TOOL,
  KITION_KIT_HOST,
  KitCanvas,
  KitEditorFrame,
  ZOOM_TOOL,
  useEngineTools,
  useKitDocument,
  useKitEditor,
  type KitCanvasHandle,
  type RasterView,
} from '@/features/kits/public'
import { notify } from '@/lib/notify'
import { DesignPagesPanel } from './design/DesignPagesPanel'
import { DESIGN_SDK, describeDesign } from './design/designKitSdk'

const DESIGN_MENU_ORDER = ['File', 'Edit', 'Layout', 'Type', 'Object', 'Table', 'View', 'Window', 'Help']
const ZOOM_STEP = 1.25

/** The view tools are the host's; the engine's other tools run in the engine. */
const HOST_TOOLS = { hand: HAND_TOOL, zoom: ZOOM_TOOL }

/** Tools left off the rail: they need panels this editor does not have yet (notes, colour themes, the content conveyor). */
const HIDDEN_TOOLS = new Set(['note', 'colorTheme', 'contentCollector', 'contentPlacer'])

type DesignWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * A page layout edited in the page, built on the Kit SDK template: the Design
 * engine runs in a worker with its own tools (type, frames, pen) through the
 * engine-tools bridge, its spreads are stacked on one canvas as in InDesign,
 * and Kition draws the rail, menus, the Pages panel, and the tools' overlays.
 */
export function DesignWebEditor({ path, active, onOpenAgent }: DesignWebEditorProps) {
  const { t } = useTranslation('workspace')
  const design = useKitDocument(KITION_KIT_HOST, DESIGN_SDK, path, active, describeDesign)
  const editor = useKitEditor(design, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const { run } = editor
  const state = design.state
  const tools = useEngineTools(design.tool, design.doc != null, design.change, {
    initial: 'selection',
    hostTools: HOST_TOOLS,
    hidden: HIDDEN_TOOLS,
    onDialog: () => notify.info(t('designKit.dialogUnavailable')),
    onDeferredKey: (key, shift) => {
      const next = toolForKeyRef.current(key, shift)
      if (next) selectRef.current(next)
    },
  })
  // Deferred keys arrive after a render; the latest shortcut lookup and selection handle them.
  const toolForKeyRef = useRef(tools.toolForKey)
  toolForKeyRef.current = tools.toolForKey
  const selectRef = useRef(tools.select)
  selectRef.current = tools.select
  const railTools = useMemo(() => tools.tools.filter((tool) => !HIDDEN_TOOLS.has(tool.id)), [tools.tools])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tools.keyDown(event)) {
      event.preventDefault()
      return
    }
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (command && key === '0') canvas.current?.fit()
    else if (command && (key === '=' || key === '+')) canvas.current?.zoomBy(ZOOM_STEP)
    else if (command && key === '-') canvas.current?.zoomBy(1 / ZOOM_STEP)
    else if (!command && !event.altKey && event.key.length === 1 && tools.toolForKey(event.key, event.shiftKey)) tools.select(tools.toolForKey(event.key, event.shiftKey)!)
    else return
    event.preventDefault()
  }

  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <KitEditorFrame
      document={design}
      editor={editor}
      title={filename}
      icon={LayoutTemplate}
      menuOrder={DESIGN_MENU_ORDER}
      menuLabel={(label) => t(`designKit.menu.${label}`, { defaultValue: label })}
      onKeyDown={keyDown}
      tools={<EngineToolRail tools={railTools} active={tools.active} onSelect={tools.select} testId="design" />}
      side={<DesignPagesPanel state={state} onShow={(area) => canvas.current?.show(area)} onAddPage={() => void run('layout.pages.insert', {})} />}
      status={(
        <span data-testid="design-status">
          {tools.status ?? (state ? t('designKit.summary', { pages: state.pageCount, stories: state.stories, selected: state.selected }) : '')}
        </span>
      )}
      statusEnd={zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
    >
      {design.doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={design.doc}
          change={design.change}
          tool={tools.canvasTool}
          initialArea={state?.spreads[0]?.area ?? null}
          decorate={tools.decorate}
          spacePans={!tools.wantsText}
          onView={(view) => setZoom(view.zoom)}
        />
      ) : null}
    </KitEditorFrame>
  )
}
