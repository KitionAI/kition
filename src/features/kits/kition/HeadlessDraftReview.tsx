import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlertIcon as AlertTriangle, BotIcon as Bot, CheckIcon as Check, LoaderCircleIcon as Loader2, XIcon as X } from '@kition/tessera-icons/react'
import { Button, Sheet } from '@kition/tessera-ui'
import { compareKitDraft, type KitsDraftComparison } from '@/api/kits'
import { notify } from '@/lib/notify'
import {
  closeHeadlessDraftReview,
  discardHeadlessDraft,
  mergeHeadlessDraft,
  openHeadlessDraftReview,
  useHeadlessDraft,
  useHeadlessDraftReview,
  watchHeadlessDrafts,
} from './headlessDrafts'

/** How many objects of each list the review shows before "and N more". */
const LISTED = 12
/** How much of a changed text the review shows on each side. */
const TEXT_SHOWN = 280

const clip = (text: string) => (text.length > TEXT_SHOWN ? `${text.slice(0, TEXT_SHOWN)}…` : text)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Next to a workspace file an agent edited as a draft outside Kition (`kition-kits-mcp --drafts`,
 * KHP A27): opens the review. The file itself is untouched until the person merges.
 */
export function HeadlessDraftBadge({ path }: { path: string }) {
  const { t } = useTranslation('workspace')
  const draft = useHeadlessDraft(path)
  if (!draft) return null
  return (
    <button
      type="button"
      className="document-tree-draft-badge"
      data-testid="headless-draft-badge"
      data-state={draft.state}
      title={t('kitEditor.headlessDraft.badgeTitle')}
      onClick={(event) => {
        event.stopPropagation()
        openHeadlessDraftReview(path)
      }}
    >
      <Bot aria-hidden="true" />
      {t('kitEditor.draft.tab')}
    </button>
  )
}

/** One side of the comparison: the kit's summary of it and, when the kit renders, its image. */
function Side({ label, png, summary, testId }: { label: string; png?: string; summary?: string; testId: string }) {
  const { t } = useTranslation('workspace')
  return (
    <figure className="kit-draft-side" data-testid={testId}>
      <figcaption>{label}</figcaption>
      {png ? <img src={`data:image/png;base64,${png}`} alt={label} /> : <div className="kit-draft-side__empty">{t('kitEditor.draft.noPreview')}</div>}
      {summary ? <p className="kit-draft-side__summary">{summary}</p> : null}
    </figure>
  )
}

function Comparison({ comparison }: { comparison: KitsDraftComparison }) {
  const { t } = useTranslation('workspace')
  const diff = comparison.diff
  const rows = useMemo(
    () =>
      diff
        ? [
            ...diff.created.map((object) => ({ ...object, change: 'created' as const })),
            ...diff.changed.map((object) => ({ ...object, change: 'changed' as const })),
            ...diff.deleted.map((object) => ({ ...object, change: 'deleted' as const })),
          ]
        : [],
    [diff],
  )
  return (
    <>
      <div className="kit-draft-review__sides">
        <Side label={t('kitEditor.draft.before')} png={comparison.previews?.base} summary={comparison.summary.base} testId="headless-draft-before" />
        <Side label={t('kitEditor.draft.after')} png={comparison.previews?.draft} summary={comparison.summary.draft} testId="headless-draft-after" />
      </div>
      {diff ? (
        <>
          <ul className="kit-draft-review__counts" data-testid="headless-draft-summary">
            <li>{t('kitEditor.draft.created', { count: diff.created.length })}</li>
            <li>{t('kitEditor.draft.changed', { count: diff.changed.length })}</li>
            <li>{t('kitEditor.draft.deleted', { count: diff.deleted.length })}</li>
          </ul>
          {rows.length === 0 ? (
            <p className="kit-draft-review__empty">{t('kitEditor.draft.noChanges')}</p>
          ) : (
            <ul className="kit-draft-review__objects">
              {rows.slice(0, LISTED).map((row) => (
                <li key={`${row.change}-${row.id}`} data-change={row.change}>
                  <span className="kit-draft-review__change">{t(`kitEditor.draft.change.${row.change}`)}</span>
                  <span className="kit-draft-review__type">{row.type || row.id}</span>
                  {row.change === 'changed' && row.fields.length ? <span className="kit-draft-review__fields">{row.fields.join(', ')}</span> : null}
                </li>
              ))}
              {rows.length > LISTED ? <li className="kit-draft-review__more">{t('kitEditor.draft.more', { count: rows.length - LISTED })}</li> : null}
            </ul>
          )}
          {diff.texts.length ? (
            <section className="kit-draft-review__texts">
              <h3>{t('kitEditor.draft.texts')}</h3>
              {diff.texts.slice(0, LISTED).map((text) => (
                <div key={`${text.id}-${text.field}`} className="kit-draft-review__text">
                  {text.before ? <del>{clip(text.before)}</del> : null}
                  {text.after ? <ins>{clip(text.after)}</ins> : null}
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <p className="kit-draft-review__empty" data-testid="headless-draft-no-diff">
          {t('kitEditor.headlessDraft.noDiff')}
        </p>
      )}
    </>
  )
}

/**
 * The review of a headless draft (KHP A27): the file now and with the draft merged, and
 * the person's Merge and Discard (A14). A merge the runtime refuses because the file changed since
 * the draft forked asks before replacing those edits; a file open in a kit editor with unsaved
 * edits is never replaced.
 */
function HeadlessDraftReviewSheet({ path }: { path: string }) {
  const { t } = useTranslation('workspace')
  const draft = useHeadlessDraft(path)
  const [comparison, setComparison] = useState<KitsDraftComparison | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  // Compared again whenever the agent changes the draft while the review is open.
  useEffect(() => {
    let current = true
    setFailure(null)
    setComparison(null)
    compareKitDraft(path).then(
      (answer) => {
        if (current) setComparison(answer)
      },
      (error: unknown) => {
        if (current) setFailure(message(error))
      },
    )
    return () => {
      current = false
    }
  }, [path, draft?.updated])

  const merge = async (overwrite: boolean) => {
    setBusy(true)
    try {
      const outcome = await mergeHeadlessDraft(path, overwrite)
      if (outcome === 'stale') setConfirmOverwrite(true)
      else if (outcome === 'dirty') notify.error(t('kitEditor.draft.mergeFailed'), { description: t('kitEditor.headlessDraft.dirty') })
      else {
        notify.success(t('kitEditor.draft.merged'), { description: t('kitEditor.headlessDraft.mergedHint') })
        closeHeadlessDraftReview()
      }
    } catch (error) {
      notify.error(t('kitEditor.draft.mergeFailed'), { description: message(error) })
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    setBusy(true)
    try {
      await discardHeadlessDraft(path)
      notify.info(t('kitEditor.draft.discarded'))
      closeHeadlessDraftReview()
    } catch (error) {
      notify.error(t('kitEditor.draft.discardFailed'), { description: message(error) })
    } finally {
      setBusy(false)
    }
  }
  const stale = confirmOverwrite || Boolean(comparison?.stale ?? draft?.stale)

  return (
    <Sheet testId="right-sheet"
      open
      onClose={closeHeadlessDraftReview}
      title={t('kitEditor.headlessDraft.title', { name: path.split('/').pop() ?? path })}
      footer={
        <div className="kit-draft-review__footer">
          <p>{t('kitEditor.headlessDraft.hint')}</p>
          <div className="kit-draft-review__actions">
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => void discard()} data-testid="headless-draft-discard">
              <X />
              {t('kitEditor.draft.discard')}
            </Button>
            {confirmOverwrite ? (
              <Button variant="danger" size="sm" type="button" disabled={busy} onClick={() => void merge(true)} data-testid="headless-draft-overwrite">
                <AlertTriangle />
                {t('kitEditor.headlessDraft.overwrite')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" type="button" disabled={busy || !comparison} onClick={() => void merge(false)} data-testid="headless-draft-merge">
                <Check />
                {t('kitEditor.draft.merge')}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="kit-draft-review" data-testid="headless-draft-review">
        {stale ? (
          <p role="alert" className="kit-draft-review__stale" data-testid="headless-draft-stale">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {t('kitEditor.headlessDraft.stale')}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="kit-draft-review__failure">
            {t('kitEditor.draft.compareFailed')}: {failure}
          </p>
        ) : !comparison ? (
          <p className="kit-draft-review__loading">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('kitEditor.draft.comparing')}
          </p>
        ) : (
          <Comparison comparison={comparison} />
        )}
      </div>
    </Sheet>
  )
}

/**
 * Watches the workspace's headless drafts while it is shown, and holds the review the badges
 * open. Mounted once, by the workspace sidebar.
 */
export function HeadlessDraftReviewHost() {
  const reviewing = useHeadlessDraftReview()
  useEffect(() => watchHeadlessDrafts(), [])
  return reviewing ? <HeadlessDraftReviewSheet key={reviewing} path={reviewing} /> : null
}
