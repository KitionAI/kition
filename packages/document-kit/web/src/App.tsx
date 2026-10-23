import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { i18n } from 'i18next'
import type { EditorView } from '@codemirror/view'
import { MessageSquare } from 'lucide-react'
import {
  Button,
  CommentsPanel,
  EditorFrame,
  KitEditorProvider,
  createKitStrings,
  toast,
  useKitEditorState,
  useKitSession,
  type CommentsPanelProps,
  type FrameTab,
  type HostConnection,
} from '@kition/kit-ui'
import { commentThreads, randomActor, relocateAnchorRange, Replica, type CommentAnchor, type ObjectId } from '@kition/kdm'
import { ConfirmProvider } from '@kition/app-ui/confirm'
import { DocumentEditor } from '@kition/document-editor/editor'
import { DOCUMENT_BODY, documentBody, documentRootId, documentSchema, replicaTextSource, type DocumentTextSource } from '@kition/document-editor/model'
import { describe, engineManifest } from './engine'
import { CATALOGS } from './strings'
import { WorkerRelay, type EngineReplica } from './workerRelay'

/** Undo and Redo keys belong to the document editor, which undoes the person's own edits. */
const editorKeys = (command: string) => command === 'edit.undo' || command === 'edit.redo'

type Session = ReturnType<typeof useKitSession<ReturnType<typeof describe>>>
type Opened = { replica: Replica; rootId: ObjectId; source: DocumentTextSource }

/** kit-ui's comment panel labels, from Kition's `document` strings. */
const COMMENT_LABELS: Record<keyof NonNullable<CommentsPanelProps['labels']>, string> = {
  title: 'comments.title',
  empty: 'comments.empty',
  newComment: 'comments.new',
  placeholder: 'comments.placeholder',
  replyPlaceholder: 'comments.replyPlaceholder',
  comment: 'comments.comment',
  reply: 'comments.reply',
  cancel: 'comments.cancel',
  resolve: 'comments.resolve',
  reopen: 'comments.reopen',
  delete: 'comments.delete',
  resolved: 'comments.resolved',
  readOnlyHistory: 'comments.history',
  you: 'comments.you',
}

/** Who comments here and how (Kit UI protocol `document.comments`); absent: unknown, as `readOnly` allows. */
function commentAccess(host: HostConnection) {
  const comments = host.init.document.comments
  return {
    me: comments?.me ?? null,
    name: comments?.name,
    canComment: comments ? comments.canComment : host.readOnly !== true,
    othersReadOnly: comments?.othersReadOnly ?? false,
  }
}

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The document has no command tabs yet: the frame shows its title, the comments toggle, and the document actions. */
const NO_TABS: FrameTab[] = []

export function App({ host, i18n }: { host: HostConnection; i18n: i18n }) {
  useDarkClass()
  const t = useMemo(() => createKitStrings(CATALOGS, host.init.locale), [host])
  const manifest = useMemo(engineManifest, [])
  const session = useKitSession(host, manifest, describe)
  const editor = useKitEditorState(session, host, t, 'document')
  const name = host.init.document.name
  const [commentsOpen, setCommentsOpen] = useState(false)
  const openThreads = session.state?.openThreads ?? 0

  return (
    <KitEditorProvider editor={editor}>
      <EditorFrame
        tabs={NO_TABS}
        title={
          <span className="document-kit-title" data-testid="document-title">
            {name}
          </span>
        }
        actions={
          <Button variant="ghost" aria-pressed={commentsOpen} title={i18n.t('comments.toggle')} data-testid="document-comments-toggle" onClick={() => setCommentsOpen((open) => !open)}>
            <MessageSquare size={16} />
            {openThreads ? <span data-testid="document-comments-count">{openThreads}</span> : null}
          </Button>
        }
        hiddenCommands={editorKeys}
      >
        <div className="document-kit-body" data-testid="document-body">
          {session.doc ? (
            <I18nextProvider i18n={i18n}>
              <ConfirmProvider>
                <DocumentKitEditor
                  session={session}
                  host={host}
                  i18n={i18n}
                  readOnly={host.readOnly === true}
                  path={name}
                  commentsOpen={commentsOpen}
                />
              </ConfirmProvider>
            </I18nextProvider>
          ) : session.failure ? (
            <div className="kui-message" data-testid="document-failed">
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
 * Kition's Markdown editor over the engine's document: the editor keeps its own replica of the
 * document, loaded from the engine's snapshot, and a `WorkerRelay` keeps it and the engine's
 * replica in step. Comments are the engine's commands, so a commenter's read-only session writes
 * them under kit-ui's comment backstop; they reach the editor's replica like any change.
 */
function DocumentKitEditor({ commentsOpen, host, i18n, path, readOnly, session }: { commentsOpen: boolean; host: HostConnection; i18n: i18n; path: string; readOnly: boolean; session: Session }) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [revision, changed] = useReducer((value: number) => value + 1, 0)
  const relay = useRef<WorkerRelay | null>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(session)
  latest.current = session
  const doc = session.doc

  // The engine's document, as the editor's own replica; a reopened document starts it again.
  useEffect(() => {
    if (!doc) return undefined
    let current = true
    let stopText = () => {}
    void doc
      .invoke<Uint8Array>('snapshot')
      .then((snapshot) => {
        if (!current) return
        const replica = Replica.load(documentSchema, snapshot, randomActor())
        const rootId = documentRootId(replica)
        const engine: EngineReplica = {
          exportChanges: (since) => latest.current.replica.exportChanges(since),
          importChanges: (changes, blobs) => latest.current.replica.importChanges(changes, blobs),
        }
        const next = new WorkerRelay(replica, engine, (error) => toast('error', 'The document could not sync with its engine', message(error)), changed)
        relay.current = next
        // The editor's edits (typing, its undo and redo) go to the engine.
        stopText = replica.subscribeText(rootId, DOCUMENT_BODY, (_delta, local) => {
          if (local) next.push()
          changed()
        })
        setOpened({ replica, rootId, source: replicaTextSource(replica, rootId, { groupTyping: true }) })
      })
      .catch((error: unknown) => toast('error', 'The document could not be opened', message(error)))
    return () => {
      current = false
      stopText()
      relay.current?.close()
      relay.current = null
      setOpened(null)
    }
  }, [doc])

  // The engine's changes from elsewhere (a co-editor, an agent, a comment) come to the editor.
  const engineRevision = session.change.revision
  useEffect(() => {
    relay.current?.pull()
  }, [engineRevision])

  const handleCreateEditor = useCallback((created: EditorView) => {
    view.current = created
  }, [])

  if (!opened) return null
  return (
    <div className="document-kit-editor">
      <div className="document-editor-surface" data-testid="document-editor" data-read-only={readOnly ? 'true' : undefined}>
        <div className="document-editor-pane relative flex h-full min-h-0 flex-col">
          <DocumentEditor source={opened.source} readOnly={readOnly} sourcePath={path} className="h-full" onCreateEditor={handleCreateEditor} />
        </div>
      </div>
      {commentsOpen ? <DocumentComments opened={opened} host={host} i18n={i18n} revision={revision} view={view} run={session.run} /> : null}
    </div>
  )
}

function DocumentComments({ host, i18n, opened, revision, run: runCommand, view }: { host: HostConnection; i18n: i18n; opened: Opened; revision: number; run: Session['run']; view: { current: EditorView | null } }) {
  const access = useMemo(() => commentAccess(host), [host])
  const [pending, setPending] = useState<CommentAnchor | null>(null)
  const threads = useMemo(() => {
    void revision
    return commentThreads(opened.replica)
  }, [opened, revision])
  const text = useMemo(() => {
    void revision
    return documentBody(opened.replica, opened.rootId)
  }, [opened, revision])
  const labels = useMemo(() => Object.fromEntries(Object.entries(COMMENT_LABELS).map(([key, id]) => [key, i18n.t(id)])), [i18n])
  const who = { ...(access.me ? { author: access.me } : {}), ...(access.name ? { name: access.name } : {}) }
  const run = (command: string, params: Record<string, unknown>) => {
    void runCommand(command, params).catch((error: unknown) => toast('error', i18n.t('comments.failed'), message(error)))
  }

  /** A new thread at the editor's selection, or on the whole document without one. */
  const startThread = () => {
    const selection = view.current?.state.selection.main
    const anchor: CommentAnchor = { object: opened.rootId, field: DOCUMENT_BODY }
    if (selection && !selection.empty) {
      const quote = view.current!.state.sliceDoc(selection.from, selection.to)
      setPending({ ...anchor, range: { start: selection.from, end: selection.to }, quote })
    } else setPending(anchor)
  }

  return (
    <aside className="kui-panel document-kit-comments" data-testid="document-comments">
      {access.canComment ? (
        <div className="document-kit-comments-header">
          <Button
            variant="ghost"
            data-testid="document-comments-new"
            // Keeps the editor's selection, which anchors the thread.
            onMouseDown={(event) => event.preventDefault()}
            onClick={startThread}
          >
            {i18n.t('comments.new')}
          </Button>
        </div>
      ) : null}
      <CommentsPanel
        threads={threads}
        me={access.me}
        canComment={access.canComment}
        othersReadOnly={access.othersReadOnly}
        pendingAnchor={pending}
        labels={labels}
        testId="document-comment-panel"
        anchorLabel={(anchor) => {
          if (!anchor.quote) return null
          return relocateAnchorRange(anchor, text) ? `“${anchor.quote}”` : i18n.t('comments.quoteGone', { quote: anchor.quote })
        }}
        onAdd={(anchor, body) => {
          setPending(null)
          run('comment.add', { ...(anchor.range ? { start: anchor.range.start, end: anchor.range.end } : {}), body, ...who })
        }}
        onCancelNew={() => setPending(null)}
        onReply={(thread, body) => run('comment.reply', { thread, body, ...who })}
        onResolve={(thread, resolved) => run('comment.resolve', { thread, resolved })}
        onDelete={(thread, comment) => run('comment.delete', { thread, comment })}
      />
    </aside>
  )
}
