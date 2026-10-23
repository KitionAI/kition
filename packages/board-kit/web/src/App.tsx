import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { ArrowUpRight, Eraser, Hand, Highlighter, MousePointer2, Pencil, Square, StickyNote, Type, type LucideIcon } from 'lucide-react'
import type { i18n } from 'i18next'
import { EditorFrame, FrameChrome, KitEditorProvider, createKitStrings, toast, useKitEditorState, useKitSession, type FocusTool, type FrameTab, type HostConnection } from '@kition/kit-ui'
import { randomActor, Replica } from '@kition/kdm'
import { ConfirmProvider } from '@kition/app-ui/confirm'
import { BoardHostProvider, type BoardHost, type WhiteboardPoint, type WhiteboardTool } from '@kition/board-editor'
import {
  useWhiteboardEditor,
  WhiteboardCanvas,
  WhiteboardMinimap,
  WhiteboardSelectionToolbar,
  WhiteboardStylePanel,
  WhiteboardToolbar,
  WhiteboardTopActions,
} from '@kition/board-editor/editor'
import { boardSchema } from '@kition/board-editor/model'
import { describe, engineManifest } from './engine'
import { CATALOGS } from './strings'
import { WorkerRelay, type EngineReplica } from './workerRelay'

/** Undo and Redo keys belong to the board editor, which undoes the person's own edits. */
const editorKeys = (command: string) => command === 'edit.undo' || command === 'edit.redo'

/**
 * What the board editor asks of its app, in a kit: nothing. Images show where their URL loads by
 * itself; picking image files and Create design are Kition features the kit does not have.
 */
const KIT_BOARD_HOST: BoardHost = {}

type Session = ReturnType<typeof useKitSession<ReturnType<typeof describe>>>

/** Kition's `.dark` theme class follows the host's color scheme (kit-ui sets `data-color-scheme`). */
function useDarkClass() {
  useEffect(() => {
    const root = document.documentElement
    const apply = () => root.classList.toggle('dark', root.dataset.colorScheme === 'dark')
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['data-color-scheme'] })
    return () => observer.disconnect()
  }, [])
}

/** The board has no command tabs yet: the frame shows its title and the document actions. */
const NO_TABS: FrameTab[] = []

/** The icon the Focus bar shows for the board's active tool (the palette's own icons). */
const TOOL_ICONS: Record<WhiteboardTool, LucideIcon> = {
  select: MousePointer2,
  hand: Hand,
  eraser: Eraser,
  rectangle: Square,
  note: StickyNote,
  text: Type,
  pen: Pencil,
  highlight: Highlighter,
  connector: ArrowUpRight,
}

export function App({ host, i18n }: { host: HostConnection; i18n: i18n }) {
  useDarkClass()
  const t = useMemo(() => createKitStrings(CATALOGS, host.init.locale), [host])
  const manifest = useMemo(engineManifest, [])
  const session = useKitSession(host, manifest, describe)
  const editor = useKitEditorState(session, host, t, 'board')
  const name = host.init.document.name
  // The board's active tool, for the Focus bar (Focus hides the board's own tool palette).
  const [focusTool, setFocusTool] = useState<FocusTool | null>(null)

  return (
    <KitEditorProvider editor={editor}>
      <EditorFrame
        tabs={NO_TABS}
        title={
          <span className="board-kit-title" data-testid="board-title">
            {name}
          </span>
        }
        hiddenCommands={editorKeys}
        focusTool={focusTool}
      >
        <div className="board-kit-body" data-testid="board-body">
          {session.doc ? (
            <I18nextProvider i18n={i18n}>
              <ConfirmProvider>
                <BoardHostProvider value={KIT_BOARD_HOST}>
                  <BoardKitEditor session={session} readOnly={host.readOnly === true} title={name.replace(/\.kiboard$/i, '')} onTool={setFocusTool} />
                </BoardHostProvider>
              </ConfirmProvider>
            </I18nextProvider>
          ) : session.failure ? (
            <div className="kui-message" data-testid="board-failed">
              {t('openFailed')}: {session.failure}
            </div>
          ) : (
            <div className="kui-message kui-muted">{t('opening')}</div>
          )}
        </div>
      </EditorFrame>
    </KitEditorProvider>
  )
}

/**
 * Kition's board editor over the engine's document: the editor keeps its own replica of the board
 * (`BoardStore`), loaded from the engine's snapshot, and a `WorkerRelay` keeps it and the
 * engine's replica in step.
 */
function BoardKitEditor({ onTool, readOnly, session, title }: { onTool: (tool: FocusTool | null) => void; readOnly: boolean; session: Session; title: string }) {
  const controller = useWhiteboardEditor()
  const { t } = useTranslation('workspace')
  const { store, replaceDocument } = controller
  const [loaded, setLoaded] = useState(false)
  const [canvasSize, setCanvasSize] = useState<WhiteboardPoint>({ x: 1200, y: 760 })
  const relay = useRef<WorkerRelay | null>(null)
  const latest = useRef(session)
  latest.current = session
  const doc = session.doc

  useEffect(() => {
    store.setReadOnly(readOnly)
  }, [readOnly, store])

  // The active tool goes to the frame's Focus bar; a read-only board has no tools.
  const tool = controller.tool
  useEffect(() => {
    onTool(readOnly ? null : { label: t(`board.toolbar.${tool}`), icon: TOOL_ICONS[tool] })
  }, [onTool, readOnly, t, tool])
  useEffect(() => () => onTool(null), [onTool])

  // The engine's document, as the editor's own replica; a reopened document starts it again.
  useEffect(() => {
    if (!doc) return undefined
    let current = true
    void doc
      .invoke<Uint8Array>('snapshot')
      .then((snapshot) => {
        if (!current) return
        replaceDocument({ replica: Replica.load(boardSchema, snapshot, randomActor()) })
        const engine: EngineReplica = {
          exportChanges: (since) => latest.current.replica.exportChanges(since),
          importChanges: (changes, blobs) => latest.current.replica.importChanges(changes, blobs),
        }
        relay.current = new WorkerRelay(store, engine, (error) => toast('error', 'The board could not sync with its engine', error instanceof Error ? error.message : String(error)))
        // What loading repaired is the editor's first change.
        relay.current.push()
        setLoaded(true)
      })
      .catch((error: unknown) => toast('error', 'The board could not be opened', error instanceof Error ? error.message : String(error)))
    return () => {
      current = false
      relay.current?.close()
      relay.current = null
      setLoaded(false)
    }
  }, [doc, replaceDocument, store])

  // The editor's commits go to the engine; the engine's changes from elsewhere come to the editor.
  useEffect(() => store.subscribe(() => relay.current?.push()), [store])
  const revision = session.change.revision
  useEffect(() => {
    relay.current?.pull()
  }, [revision])

  const handleSizeChange = useCallback((size: WhiteboardPoint) => {
    setCanvasSize((current) => (current.x === size.x && current.y === size.y ? current : size))
  }, [])

  if (!loaded) return null
  return (
    <div
      className="relative h-full min-h-0 w-full bg-background"
      data-testid="whiteboard-editor-pane"
      data-read-only={readOnly ? 'true' : undefined}
    >
      <WhiteboardCanvas canvasSize={canvasSize} controller={controller} onSizeChange={handleSizeChange} readOnly={readOnly} title={title} />
      <WhiteboardTopActions canvasSize={canvasSize} controller={controller} title={title} />
      {readOnly ? null : (
        <>
          {/* The bottom tool palette is the kit's own bar: Focus hides it (its floating bar shows the tool). */}
          <FrameChrome>
            <WhiteboardToolbar controller={controller} canvasSize={canvasSize} />
          </FrameChrome>
          <WhiteboardSelectionToolbar controller={controller} />
        </>
      )}
      <WhiteboardMinimap canvasSize={canvasSize} controller={controller} />
      {readOnly ? null : <WhiteboardStylePanel controller={controller} />}
    </div>
  )
}
