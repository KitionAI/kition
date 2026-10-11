import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'
import {
  HAND_TOOL,
  KITION_KIT_HOST,
  KitCanvas,
  KitEditorFrame,
  ZOOM_TOOL,
  EngineToolRail,
  useEngineTools,
  useKitDocument,
  useKitEditor,
  type KitCanvasHandle,
  type KitEngineInfo,
  type RasterRect,
  type RasterView,
} from '@/features/kits/public'
import { notify } from '@/lib/notify'
import type { StandardKitSpec } from './standardKits'

const ZOOM_STEP = 1.25

/** The view tools are the host's; the engine's other tools run in the engine. */
const HOST_TOOLS = { hand: HAND_TOOL, zoom: ZOOM_TOOL }
const NO_TOOLS: ReadonlySet<string> = new Set()

function inspectedOf(info: KitEngineInfo) {
  return (info.inspected ?? {}) as Record<string, unknown>
}

/**
 * The in-page editor of a kit with no editor of its own, built on the Kit SDK template: the
 * engine runs in a worker and its tools through the engine-tools bridge; Kition draws the rail,
 * the menus, the command line, and the tools' overlays.
 */
type StandardKitEditorProps = {
  spec: StandardKitSpec
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

export function StandardKitEditor({ spec, path, active, onOpenAgent }: StandardKitEditorProps) {
  const { t } = useTranslation('workspace')
  const document = useKitDocument(KITION_KIT_HOST, spec.sdk, path, active, inspectedOf)
  const editor = useKitEditor(document, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [line, setLine] = useState('')
  const hidden = spec.tools?.hidden ?? NO_TOOLS
  const tools = useEngineTools(document.tool, document.doc != null && spec.tools != null, document.change, {
    initial: spec.tools?.initial ?? 'hand',
    hostTools: HOST_TOOLS,
    hidden,
    onDialog: () => notify.info(t('kitEditor.dialogUnavailable')),
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
  const railTools = useMemo(() => tools.tools.filter((tool) => !hidden.has(tool.id)), [hidden, tools.tools])

  // A menu command may start one of the engine's tools (Draw > Line); the rail follows.
  const run = async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null) => {
    const result = await editor.run(command, params, damage)
    tools.refresh()
    return result
  }

  const runLine = async () => {
    const text = line
    setLine('')
    await run('commandLine', { text })
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tools.keyDown(event)) {
      event.preventDefault()
      return
    }
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const shortcut = !command && !event.altKey && event.key.length === 1 ? tools.toolForKey(event.key, event.shiftKey) : null
    if (command && key === '0') canvas.current?.fit()
    else if (command && (key === '=' || key === '+')) canvas.current?.zoomBy(ZOOM_STEP)
    else if (command && key === '-') canvas.current?.zoomBy(1 / ZOOM_STEP)
    else if (shortcut) tools.select(shortcut)
    else return
    event.preventDefault()
  }

  const filename = path.split('/').filter(Boolean).pop() || path
  const values = document.state ? spec.summary(document.state) : null

  return (
    <KitEditorFrame
      document={document}
      editor={{ ...editor, run }}
      title={filename}
      icon={spec.icon}
      menuOrder={spec.menuOrder}
      menuLabel={(label) => t(`${spec.key}Kit.menu.${label}`, { defaultValue: t(`kitEditor.menu.${label}`, { defaultValue: label }) })}
      onKeyDown={keyDown}
      tools={spec.tools ? <EngineToolRail tools={railTools} active={tools.active} onSelect={tools.select} testId={spec.key} /> : null}
      bottom={spec.commandLine ? (
        <form
          className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-background px-3"
          onSubmit={(event) => {
            event.preventDefault()
            void runLine()
          }}
        >
          <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0 text-xs text-muted-foreground" data-testid={`${spec.key}-prompt`}>{tools.status ?? ''}</span>
          <input
            className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
            value={line}
            onChange={(event) => setLine(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears the line and cancels the running command, as on the canvas.
              if (event.key !== 'Escape') return
              setLine('')
              tools.keyDown({ key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false })
            }}
            placeholder={t('kitEditor.commandLine')}
            aria-label={t('kitEditor.commandLine')}
            spellCheck={false}
            data-testid={`${spec.key}-command-line`}
          />
        </form>
      ) : null}
      status={<span data-testid={`${spec.key}-status`}>{values ? t(`${spec.key}Kit.summary`, values) : ''}</span>}
      statusEnd={zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
    >
      {document.doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={document.doc}
          change={document.change}
          tool={spec.tools ? tools.canvasTool : HAND_TOOL}
          initialArea={document.state && spec.initialArea ? spec.initialArea(document.state) : null}
          decorate={tools.decorate}
          spacePans={!tools.wantsText}
          onView={(view) => setZoom(view.zoom)}
        />
      ) : null}
    </KitEditorFrame>
  )
}
