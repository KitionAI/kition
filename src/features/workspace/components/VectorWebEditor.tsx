import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { PenTool } from 'lucide-react'
import {
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
import { VectorLayersPanel } from './vector/VectorLayersPanel'
import { VectorToolRail } from './vector/VectorToolRail'
import { VECTOR_SDK, describeVector } from './vector/vectorKitSdk'

const VECTOR_MENU_ORDER = ['File', 'Edit', 'Object', 'Type', 'Select', 'Effect', 'View', 'Window', 'Help']
const ZOOM_STEP = 1.25

/** The view tools are the host's; the engine's other tools run in the engine. */
const HOST_TOOLS = { hand: HAND_TOOL, zoom: ZOOM_TOOL }

/**
 * Tools left off the rail: they need panels or dialogs this editor does not
 * have yet (graphs, symbols, perspective grids), or rotate a view Kition
 * keeps square (Rotate View, Print Tiling).
 */
const HIDDEN_TOOLS = new Set([
  'columnGraph', 'stackedColumnGraph', 'barGraph', 'stackedBarGraph', 'lineGraph', 'areaGraph', 'scatterGraph', 'pieGraph', 'radarGraph',
  'symbolSprayer', 'symbolShifter', 'symbolScruncher', 'symbolSizer', 'symbolSpinner', 'symbolStainer', 'symbolScreener', 'symbolStyler',
  'perspectiveGrid', 'perspectiveSelection', 'rotateView', 'printTiling',
])

type VectorWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * A vector drawing edited in the page, built on the Kit SDK template: the
 * Vector engine runs in a worker, renders sharp at any zoom, and runs its own
 * tools through the engine-tools bridge; Kition draws the rail, the menus,
 * the Layers panel, and the tools' overlays.
 */
export function VectorWebEditor({ path, active, onOpenAgent }: VectorWebEditorProps) {
  const { t } = useTranslation('workspace')
  const vector = useKitDocument(KITION_KIT_HOST, VECTOR_SDK, path, active, describeVector)
  const editor = useKitEditor(vector, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const { run } = editor
  const tools = useEngineTools(vector.tool, vector.doc != null, vector.change, {
    initial: 'selection',
    hostTools: HOST_TOOLS,
    hidden: HIDDEN_TOOLS,
    onDialog: () => notify.info(t('vectorKit.dialogUnavailable')),
  })
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
  const state = vector.state
  const bounds = state?.selectionBounds

  return (
    <KitEditorFrame
      document={vector}
      editor={editor}
      title={filename}
      icon={PenTool}
      menuOrder={VECTOR_MENU_ORDER}
      menuLabel={(label) => t(`vectorKit.menu.${label}`, { defaultValue: label })}
      onKeyDown={keyDown}
      tools={<VectorToolRail tools={railTools} active={tools.active} onSelect={tools.select} />}
      side={<VectorLayersPanel state={state} onRun={(command, params) => void run(command, params)} />}
      status={(
        <span data-testid="vector-status">
          {tools.status ?? (state ? t('vectorKit.summary', { objects: state.objects, artboards: state.artboards, selected: state.selection.length }) : '')}
        </span>
      )}
      statusEnd={(
        <>
          {bounds ? (
            <span className="tabular-nums" data-testid="vector-selection-size">
              {t('vectorKit.selectionSize', { width: Math.round(bounds.width * 100) / 100, height: Math.round(bounds.height * 100) / 100 })}
            </span>
          ) : null}
          {zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
        </>
      )}
    >
      {vector.doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={vector.doc}
          change={vector.change}
          tool={tools.canvasTool}
          decorate={tools.decorate}
          onView={(view) => setZoom(view.zoom)}
        />
      ) : null}
    </KitEditorFrame>
  )
}
