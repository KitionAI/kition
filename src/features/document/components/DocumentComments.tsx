/**
 * Comment threads on a Markdown document (Kit Standard 2.0 rule M23): a button with the number of
 * open threads, and a side panel that lists them and opens, replies to, resolves, and deletes
 * them. A new thread is anchored to the text selected in the editor (or the whole document). The
 * threads live in the document's replica beside the text, never in the Markdown file, and travel
 * to co-editors with the rest of the replica.
 *
 * Who may do what follows `useDocumentCommentAccess`: a viewer reads; a commenter (whose text is
 * read-only) writes comments; without co-editing, threads others opened are read-only history.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageSquare, MessageSquarePlus, RotateCcw, Trash2, X } from 'lucide-react'
import { Button, Textarea } from '@kition/app-ui'
import { cn } from '@kition/app-ui/utils'
import { addThread, commentThreads, deleteComment, person, relocateAnchorRange, reply, setResolved, type CommentAnchor, type CommentThread } from '@/lib/kdm'
import { notify } from '@/lib/notify'
import { useDocumentCommentAccess } from '@/services/documentComments'
import type { DocumentSession } from '@/features/document/kdm/documentSession'
import { DOCUMENT_BODY, DOCUMENT_ROOT } from '@kition/document-editor/model'

const QUOTE_LIMIT = 500

/** The text selected in a Markdown editor of the page, if any. */
function editorSelection(): string {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  if (!selection || selection.isCollapsed) return ''
  const node = selection.anchorNode
  const element = node instanceof Element ? node : node?.parentElement
  if (!element?.closest('.cm-content')) return ''
  return selection.toString().trim().slice(0, QUOTE_LIMIT)
}

/** The session's threads, read again whenever its comments or text change. */
function useThreads(session: DocumentSession): CommentThread[] {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1)
    const stopComments = session.subscribeComments(bump)
    const stopText = session.subscribeText(bump)
    return () => {
      stopComments()
      stopText()
    }
  }, [session])
  return useMemo(() => {
    void revision
    const replica = session.replica
    return replica ? commentThreads(replica) : []
  }, [session, revision])
}

function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus, testId }: { placeholder: string; submitLabel: string; onSubmit: (body: string) => void; onCancel?: () => void; autoFocus?: boolean; testId: string }) {
  const { t } = useTranslation('document')
  const [body, setBody] = useState('')
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    const text = body.trim()
    if (!text) return
    onSubmit(text)
    setBody('')
  }
  return (
    <form className="space-y-2" onSubmit={send}>
      <Textarea
        value={body}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="min-h-[56px] resize-y text-[13px]"
        data-testid={`${testId}-input`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
          if (event.key === 'Escape' && onCancel) onCancel()
        }}
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('comments.cancel')}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={!body.trim()} data-testid={`${testId}-send`}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

const time = (created: string) => {
  const date = new Date(created)
  return Number.isNaN(date.getTime()) ? created : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function DocumentComments({ session, path, readOnly }: { session: DocumentSession; path: string; readOnly: boolean }) {
  const { t } = useTranslation('document')
  const access = useDocumentCommentAccess(path, readOnly)
  const threads = useThreads(session)
  const text = useSyncExternalStore(useCallback((listener) => session.subscribeText(listener), [session]), () => session.text())
  const [open, setOpen] = useState(false)
  /** The anchor of the thread being opened, while its composer shows. */
  const [pending, setPending] = useState<CommentAnchor | null>(null)
  const openCount = threads.filter((thread) => !thread.resolved).length

  const write = (label: string, run: Parameters<DocumentSession['transactComments']>[1]) => {
    try {
      session.transactComments(person(access.me, label), run)
    } catch (error) {
      notify.error(t('comments.failed'), { description: error instanceof Error ? error.message : String(error) })
    }
  }
  const said = (body: string) => ({ author: access.me, ...(access.name ? { name: access.name } : {}), body, created: new Date().toISOString() })

  const startThread = () => {
    const replica = session.replica
    const root = replica?.objectsOfType(DOCUMENT_ROOT)[0]
    if (!root) return
    const quote = editorSelection()
    const at = quote ? session.text().indexOf(quote) : -1
    setPending(at >= 0 ? { object: root, field: DOCUMENT_BODY, range: { start: at, end: at + quote.length }, quote } : { object: root, field: DOCUMENT_BODY })
    setOpen(true)
  }

  const anchorText = (anchor: CommentAnchor | null) => {
    if (!anchor?.quote) return null
    return relocateAnchorRange(anchor, text) ? `“${anchor.quote}”` : t('comments.quoteGone', { quote: anchor.quote })
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute right-4 top-14 z-20 h-7 gap-1 rounded-lg border border-border bg-background px-2 text-muted-foreground shadow-sm hover:text-foreground"
        title={t('comments.toggle')}
        aria-label={t('comments.toggle')}
        aria-pressed={open}
        data-testid="document-comments-toggle"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        <MessageSquare className="size-4" />
        {openCount ? <span className="text-[12px]" data-testid="document-comments-count">{openCount}</span> : null}
      </Button>
      {open ? (
        <aside
          className="absolute bottom-3 right-4 top-24 z-20 flex w-[320px] flex-col rounded-xl border border-border bg-background shadow-sm"
          aria-label={t('comments.title')}
          data-testid="document-comments"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="flex-1 text-[13px] font-semibold">{t('comments.title')}</span>
            {access.canComment ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                title={t('comments.new')}
                aria-label={t('comments.new')}
                data-testid="document-comments-new"
                // Keeps the editor's selection, which anchors the thread.
                onMouseDown={(event) => event.preventDefault()}
                onClick={startThread}
              >
                <MessageSquarePlus className="size-4" />
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="icon" className="size-7" title={t('comments.close')} aria-label={t('comments.close')} onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-3">
            {pending && access.canComment ? (
              <div className="space-y-2 rounded-xl border border-primary/40 p-3" data-testid="document-comments-composer">
                {anchorText(pending) ? <div className="truncate text-[12px] text-muted-foreground">{anchorText(pending)}</div> : null}
                <Composer
                  autoFocus
                  placeholder={t('comments.placeholder')}
                  submitLabel={t('comments.comment')}
                  testId="document-comments"
                  onCancel={() => setPending(null)}
                  onSubmit={(body) => {
                    write('comment', (tx) => addThread(tx, pending, said(body)))
                    setPending(null)
                  }}
                />
              </div>
            ) : null}
            {!threads.length && !pending ? <p className="text-[13px] text-muted-foreground">{access.canComment ? t('comments.empty') : t('comments.emptyReadOnly')}</p> : null}
            {threads.map((thread) => {
              const opener = thread.comments[0]?.author ?? ''
              const writable = access.canComment && (!access.othersReadOnly || access.mine(opener))
              const quote = anchorText(thread.anchor)
              return (
                <div
                  key={thread.id}
                  className={cn('space-y-2 rounded-xl border border-border p-3 shadow-sm', thread.resolved && 'opacity-70')}
                  data-testid="document-comment-thread"
                  data-resolved={thread.resolved ? 'true' : 'false'}
                >
                  {quote ? <div className="truncate border-l-2 border-primary/40 pl-2 text-[12px] text-muted-foreground">{quote}</div> : null}
                  {thread.comments.map((comment) => {
                    const mine = access.mine(comment.author)
                    return (
                      <div key={comment.id} className="space-y-0.5" data-testid="document-comment" data-author={comment.author}>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold">{mine ? t('comments.you') : comment.name || comment.author}</span>
                          <span className="text-[11px] text-muted-foreground">{time(comment.created)}</span>
                          <span className="flex-1" />
                          {writable && mine ? (
                            <Button type="button" variant="ghost" size="icon" className="size-6" title={t('comments.delete')} aria-label={t('comments.delete')} data-testid="document-comment-delete" onClick={() => write('delete comment', (tx) => deleteComment(tx, thread.id, comment.id))}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13px]" data-testid="document-comment-body">{comment.body}</p>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-2">
                    {thread.resolved ? <span className="text-[12px] text-muted-foreground">{t('comments.resolved')}</span> : null}
                    {!writable && access.othersReadOnly && !access.mine(opener) ? (
                      <span className="text-[12px] text-muted-foreground" data-testid="document-comment-history">{t('comments.history')}</span>
                    ) : null}
                    <span className="flex-1" />
                    {writable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2"
                        data-testid="document-comment-resolve"
                        onClick={() => write(thread.resolved ? 'reopen comment' : 'resolve comment', (tx) => setResolved(tx, thread.id, !thread.resolved))}
                      >
                        {thread.resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
                        {t(thread.resolved ? 'comments.reopen' : 'comments.resolve')}
                      </Button>
                    ) : null}
                  </div>
                  {writable && !thread.resolved ? (
                    <Composer placeholder={t('comments.replyPlaceholder')} submitLabel={t('comments.reply')} testId="document-comment-reply" onSubmit={(body) => write('reply', (tx) => void reply(tx, thread.id, said(body)))} />
                  ) : null}
                </div>
              )
            })}
          </div>
        </aside>
      ) : null}
    </>
  )
}
