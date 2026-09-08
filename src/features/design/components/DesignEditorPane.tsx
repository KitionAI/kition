import { useConfirm } from '@/components/confirm'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import {
  Circle,
  ImagePlus,
  Layers,
  LayoutTemplate,
  Minus,
  MousePointer2,
  SlidersHorizontal,
  Square,
  Type,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { notify } from '@/lib/notify'
import { useDesignSession } from '../hooks/useDesignSession'
import { useDesignImages } from '../hooks/useDesignImages'
import {
  createDesignNode,
  designId,
  type DesignDocument,
  type DesignNode,
} from '../lib/designTypes'
import type { DesignSession } from '../lib/designSession'
import { importDesignImage, insertDesignImage } from '../lib/designAssets'
import { duplicateNodes } from '../lib/designCommands'
import { parseDesign, serializeDesign } from '../lib/designSerialization'
import {
  copyDesignImage,
  DesignExportError,
  renderDesignImage,
  saveDesignImage,
} from '../lib/designExport'
import { createDesignFile } from '../lib/designFile'
import { registerDesignImageTarget } from '../lib/designImageTargets'
import { translation } from '../lib/designGeometry'
import { DesignToolbar } from './DesignToolbar'
import { DesignCanvas } from './DesignCanvas'
import { DesignInspector } from './DesignInspector'
import { DesignLayers } from './DesignLayers'
import { DesignLibrary } from './DesignLibrary'
import './design.css'
export function DesignEditorPane({
  root,
  path,
  title,
  active,
}: {
  root: string
  path: string
  title: string
  active: boolean
}) {
  const { t } = useTranslation('design'),
    [reload, setReload] = useState(0),
    { session, error } = useDesignSession(root, path, reload)
  if (!session)
    return (
      <div className="design-loading" role={error ? 'alert' : 'status'}>
        <p>{error ? t('errors.open') : t('loading')}</p>
        {error ? (
          <>
            <p className="design-help">{t('errors.preserved')}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReload((value) => value + 1)}
            >
              {t('retry')}
            </Button>
          </>
        ) : null}
      </div>
    )
  return (
    <DesignEditor
      key={`${root}:${path}:${reload}`}
      session={session}
      title={title}
      active={active}
      onReload={() => {
        session.discardRecovery()
        setReload((value) => value + 1)
      }}
    />
  )
}
function isTextTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable="true"]')
  )
}
function DesignEditor({
  session,
  title,
  active,
  onReload,
}: {
  session: DesignSession
  title: string
  active: boolean
  onReload: () => void
}) {
  const confirm = useConfirm()
  const { t } = useTranslation('design'),
    store = session.store,
    state = useSyncExternalStore(store.subscribe, store.getSnapshot),
    status = useSyncExternalStore(session.subscribe, session.getStatus)
  const doc = state.preview || state.document,
    selection = state.selection,
    { images, missing } = useDesignImages(session.root, doc)
  const [panel, setPanel] = useState<
      'layouts' | 'layers' | 'properties' | null
    >('layouts'),
    [editingId, setEditingId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    pendingLayoutRef = useRef(false)
  const input = useRef<HTMLInputElement>(null),
    rootElement = useRef<HTMLDivElement>(null),
    isActive = useRef(active)
  isActive.current = active
  const focusCanvas = () =>
    rootElement.current?.querySelector<HTMLElement>('.design-stage')?.focus()
  const insertAsset = useCallback(
    (asset: Parameters<typeof insertDesignImage>[1]) => {
      const result = insertDesignImage(store.getSnapshot().document, asset)
      store.commit(result.document)
      store.select([result.nodeId])
      setPanel('properties')
    },
    [store],
  )
  useEffect(
    () => registerDesignImageTarget(session.root, session.path, insertAsset),
    [session, insertAsset],
  )
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (session.getStatus() !== 'saved') {
        event.preventDefault()
        void session.flush().catch(() => {})
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [session])
  useEffect(() => {
    if (!active) {
      setEditingId(null)
      store.cancel()
    }
  }, [active, store])
  async function importImage(blob: Blob) {
    setBusy(true)
    try {
      const asset = await importDesignImage(session.root, blob)
      if (isActive.current) {
        insertAsset(asset)
        focusCanvas()
      }
    } catch (error) {
      notify.error(t('errors.image'), { description: String(error) })
    } finally {
      setBusy(false)
    }
  }
  function insert(type: DesignNode['type']) {
    const p = doc.pages[0],
      width = Math.min(p.width * 0.7, type === 'text' ? 680 : 320),
      height = Math.min(
        p.height * 0.5,
        type === 'text' ? 240 : type === 'line' ? 1 : 240,
      )
    const n = createDesignNode(type, {
      name: t(`tools.${type}`),
      text: type === 'text' ? t('newText') : '',
      width,
      height,
      fontSize: Math.min(80, p.width / 10),
      transform: [1, 0, 0, 1, (p.width - width) / 2, (p.height - height) / 2],
    })
    try {
      store.execute({ type: 'insert', nodes: [n] })
      store.select([n.id])
      setPanel('properties')
      if (type === 'text') setEditingId(n.id)
      else focusCanvas()
    } catch (error) {
      notify.error(t('errors.edit'), { description: String(error) })
    }
  }
  async function exportImage(format: 'png' | 'jpeg' | 'copy') {
    setBusy(true)
    try {
      const frozen = structuredClone(store.getSnapshot().document),
        blob = await renderDesignImage(
          frozen,
          session.root,
          format === 'jpeg' ? 'jpeg' : 'png',
        )
      if (format === 'copy') {
        await copyDesignImage(blob)
        notify.success(t('copied'))
      } else
        await saveDesignImage(
          blob,
          `${title}.${format === 'jpeg' ? 'jpg' : 'png'}`,
          t('export'),
        )
    } catch (error) {
      notify.error(t('errors.export'), {
        description:
          error instanceof DesignExportError
            ? t(`errors.${error.code}`)
            : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  function applyStarter(value: DesignDocument) {
    store.commit({
      ...value,
      id: doc.id,
      title: doc.title,
      assets: { ...doc.assets, ...value.assets },
    })
    store.select([])
    setPanel(null)
    focusCanvas()
  }
  async function chooseStarter(value: DesignDocument) {
    if (pendingLayoutRef.current) return
    const revision = store.getSnapshot().document.revision
    pendingLayoutRef.current = true
    try {
      const accepted =
        !doc.pages[0].children.length ||
        (await confirm({
          title: t('replaceLayout'),
          message: t('replaceLayoutHint'),
          confirmLabel: t('replaceLayout'),
          cancelLabel: t('cancel'),
        }))
      if (
        accepted &&
        isActive.current &&
        store.getSnapshot().document.revision === revision
      )
        applyStarter(value)
    } finally {
      pendingLayoutRef.current = false
    }
  }
  async function saveCopy() {
    try {
      const file = await createDesignFile(
        session.root,
        session.path.includes('/')
          ? session.path.slice(0, session.path.lastIndexOf('/'))
          : '',
        { ...store.getSnapshot().document, title: `${title} copy` },
      )
      onReload()
      window.dispatchEvent(
        new CustomEvent('kition:search:open-path', {
          detail: { path: file.path },
        }),
      )
    } catch (error) {
      notify.error(t('errors.save'), { description: String(error) })
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (!active || isTextTarget(event.target) || event.nativeEvent.isComposing)
      return
    const mod = event.metaKey || event.ctrlKey,
      key = event.key.toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      event.shiftKey ? store.redo() : store.undo()
      return
    }
    if (mod && key === 'y') {
      event.preventDefault()
      store.redo()
      return
    }
    if (mod && key === 's') {
      event.preventDefault()
      void session.flush().catch(() => notify.error(t('errors.save')))
      return
    }
    if (mod && key === 'a') {
      event.preventDefault()
      store.select(doc.pages[0].children)
      return
    }
    if (mod && key === 'g') {
      event.preventDefault()
      store.execute({
        type: event.shiftKey ? 'ungroup' : 'group',
        ids: selection,
      })
      return
    }
    if (mod && key === 'd') {
      event.preventDefault()
      store.execute({ type: 'duplicate', ids: selection })
      return
    }
    if (key === 'escape') {
      store.cancel()
      store.select([])
      return
    }
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault()
      store.execute({ type: 'remove', ids: selection })
      return
    }
    if (key.startsWith('arrow') && selection.length) {
      event.preventDefault()
      const amount = event.shiftKey ? 10 : 1
      store.execute(
        {
          type: 'transform',
          ids: selection,
          matrix: translation(
            key === 'arrowleft' ? -amount : key === 'arrowright' ? amount : 0,
            key === 'arrowup' ? -amount : key === 'arrowdown' ? amount : 0,
          ),
        },
        'nudge',
      )
    }
  }
  function copyObjects(event: ClipboardEvent) {
    if (!active || isTextTarget(event.target) || !selection.length) return
    const copied = duplicateNodes(doc, selection, 0),
      subset = {
        ...doc,
        id: designId(),
        nodes: Object.fromEntries(copied.nodes.map((n) => [n.id, n])),
        pages: [{ ...doc.pages[0], children: copied.roots }],
      } as DesignDocument
    event.preventDefault()
    event.stopPropagation()
    event.clipboardData.setData(
      'application/x-kition-design',
      JSON.stringify({ root: session.root, content: serializeDesign(subset) }),
    )
    event.clipboardData.setData('text/plain', t('copiedLayers'))
  }
  function paste(event: ClipboardEvent) {
    if (!active || isTextTarget(event.target)) return
    const file = Array.from(event.clipboardData.files).find((file) =>
      file.type.startsWith('image/'),
    )
    const raw = event.clipboardData.getData('application/x-kition-design')
    if (!file && !raw) return
    event.preventDefault()
    event.stopPropagation()
    if (file) {
      void importImage(file)
      return
    }
    try {
      const payload = JSON.parse(raw)
      if (payload.root !== session.root)
        throw new Error('Paste layers within their source workspace')
      const source = parseDesign(payload.content),
        copied = duplicateNodes(source, source.pages[0].children)
      const next = structuredClone(store.getSnapshot().document)
      next.assets = { ...next.assets, ...source.assets }
      for (const n of copied.nodes) next.nodes[n.id] = n
      next.pages[0].children.push(...copied.roots)
      store.commit(next)
      store.select(copied.roots)
    } catch (error) {
      notify.error(t('errors.edit'), { description: String(error) })
    }
  }
  const rail = [
    {
      key: 'select',
      Icon: MousePointer2,
      click: () => {
        setPanel(null)
        store.select([])
      },
    },
    { key: 'text', Icon: Type, click: () => insert('text') },
    { key: 'image', Icon: ImagePlus, click: () => input.current?.click() },
    { key: 'rectangle', Icon: Square, click: () => insert('rectangle') },
    { key: 'ellipse', Icon: Circle, click: () => insert('ellipse') },
    { key: 'line', Icon: Minus, click: () => insert('line') },
    {
      key: 'layouts',
      Icon: LayoutTemplate,
      click: () => setPanel(panel === 'layouts' ? null : 'layouts'),
    },
    {
      key: 'layers',
      Icon: Layers,
      click: () => setPanel(panel === 'layers' ? null : 'layers'),
    },
    {
      key: 'properties',
      Icon: SlidersHorizontal,
      click: () => setPanel(panel === 'properties' ? null : 'properties'),
    },
  ] as const
  return (
    <div
      ref={rootElement}
      className="design-editor"
      data-testid="design-editor"
      onKeyDown={keyboard}
      onKeyUp={(event) => {
        if (!isTextTarget(event.target)) store.endCoalescing()
      }}
      onCopy={copyObjects}
      onPaste={paste}
    >
      <DesignToolbar
        title={title}
        status={status}
        size={`${doc.pages[0].width} × ${doc.pages[0].height}`}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        busy={busy}
        onUndo={store.undo}
        onRedo={store.redo}
        onSize={() => {
          store.select([])
          setPanel('properties')
        }}
        onExport={(format) => void exportImage(format)}
      />
      {['conflict', 'error', 'recovered'].includes(status) ? (
        <div className="design-alert" role="alert">
          <span>
            {t(
              status === 'conflict'
                ? 'errors.conflict'
                : status === 'recovered'
                  ? 'recovered'
                  : 'errors.save',
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={onReload}>
            {t('reloadSaved')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void saveCopy()}>
            {t('saveCopy')}
          </Button>
          {status !== 'conflict' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void session.flush().catch(() => {})}
            >
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {missing.length ? (
        <div className="design-alert" role="alert">
          {t('errors.missing', { count: missing.length })}
        </div>
      ) : null}
      <div className="design-workbench">
        <div
          className="design-tool-rail"
          role="toolbar"
          aria-label={t('toolsLabel')}
        >
          {rail.map(({ key, Icon, click }) => (
            <Button
              key={key}
              variant="ghost"
              size="icon"
              disabled={busy && key === 'image'}
              title={t(`tools.${key}`)}
              aria-label={t(`tools.${key}`)}
              aria-pressed={panel === key}
              onClick={click}
            >
              <Icon />
            </Button>
          ))}
        </div>
        {panel && panel !== 'properties' ? (
          <aside className="design-side-panel" aria-label={t(panel)}>
            <Button
              className="design-panel-close"
              variant="ghost"
              size="icon"
              aria-label={t('closePanel')}
              onClick={() => setPanel(null)}
            >
              <X />
            </Button>
            {panel === 'layouts' ? (
              <DesignLibrary
                onApply={(value) => {
                  void chooseStarter(value)
                }}
              />
            ) : (
              <DesignLayers
                document={doc}
                selection={selection}
                store={store}
              />
            )}
          </aside>
        ) : null}
        <DesignCanvas
          document={doc}
          selection={selection}
          store={store}
          images={images}
          active={active}
          editingId={editingId}
          setEditingId={setEditingId}
        />
        {panel === 'properties' ? (
          <aside
            className="design-side-panel design-inspector"
            aria-label={t('properties')}
          >
            <Button
              className="design-panel-close"
              variant="ghost"
              size="icon"
              aria-label={t('closePanel')}
              onClick={() => setPanel(null)}
            >
              <X />
            </Button>
            <DesignInspector
              document={doc}
              selection={selection}
              store={store}
            />
          </aside>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label={t('importImage')}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importImage(file)
        }}
      />
    </div>
  )
}
