import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, FileDiff, Loader2, X } from 'lucide-react'
import { Button } from '@kition/app-ui/button'
import { RightSheet } from '@kition/app-ui/RightSheet'
import { notify } from '@/lib/notify'
import type { DraftComparison, DraftInfo, DraftOrigin, DraftSummary, KitConnection } from '../host/mountKit'
import { useKitDraft } from './kitDrafts'

/** How many objects of each list the review shows before "and N more". */
const LISTED = 12
/** How much of a changed text the review shows on each side. */
const TEXT_SHOWN = 280

/**
 * Above a kit document the agent edits as a draft (Kit Standard 2.0 A12): the document itself is
 * untouched until the person merges the draft. Review opens the comparison; Discard drops it.
 */
function KitDraftBanner({ info, onReview, onDiscard }: { info: DraftInfo; onReview: () => void; onDiscard: () => void }) {
  const { t } = useTranslation('workspace')
  if (info.state === 'none') return null
  const ready = info.state === 'ready'
  return (
    <div className="document-revision-toolbar kit-draft-banner" data-testid="kit-draft-banner" data-state={info.state} role="region" aria-label={t('kitEditor.draft.title')}>
      <div className="document-revision-toolbar__summary">
        <span className="document-revision-toolbar__icon" aria-hidden="true">
          {ready ? <Bot /> : <Loader2 className="animate-spin" />}
        </span>
        <span className="min-w-0">
          <strong>{ready ? t('kitEditor.draft.bannerReady') : t('kitEditor.draft.bannerOpen')}</strong>
          <span>{t('kitEditor.draft.bannerHint')}</span>
        </span>
      </div>
      <div className="document-revision-toolbar__actions">
        <Button variant="outline" size="md" type="button" onClick={onDiscard} data-testid="kit-draft-discard">
          <X />
          {t('kitEditor.draft.discard')}
        </Button>
        <Button variant={ready ? 'default' : 'outline'} size="md" type="button" onClick={onReview} data-testid="kit-draft-review">
          <FileDiff />
          {t('kitEditor.draft.review')}
        </Button>
      </div>
    </div>
  )
}

/** The changed objects, grouped by what happened to them, as one list for the review. */
function changeRows(summary: DraftSummary) {
  return [
    ...summary.created.map((object) => ({ ...object, change: 'created' as const })),
    ...summary.changed.map((object) => ({ ...object, change: 'changed' as const })),
    ...summary.deleted.map((object) => ({ ...object, change: 'deleted' as const })),
  ]
}

const clip = (text: string) => (text.length > TEXT_SHOWN ? `${text.slice(0, TEXT_SHOWN)}…` : text)

/** One side of the comparison, rendered by the kit's engine. */
function Side({ label, png, testId }: { label: string; png: string | null; testId: string }) {
  const { t } = useTranslation('workspace')
  return (
    <figure className="kit-draft-side" data-testid={testId}>
      <figcaption>{label}</figcaption>
      {png ? <img src={`data:image/png;base64,${png}`} alt={label} /> : <div className="kit-draft-side__empty">{t('kitEditor.draft.noPreview')}</div>}
    </figure>
  )
}

/**
 * The review of the agent's draft: the document now and as merging the draft leaves it, both
 * rendered by the kit, and what the merge creates, changes, and removes. Merge and Discard are
 * the person's explicit decision (standard A14); the agent can only ask for this review.
 */
function KitDraftReviewSheet({
  open,
  info,
  compare,
  onMerge,
  onDiscard,
  onClose,
}: {
  open: boolean
  info: DraftInfo
  compare: () => Promise<DraftComparison>
  onMerge: () => Promise<void>
  onDiscard: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('workspace')
  const [comparison, setComparison] = useState<DraftComparison | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Compared again whenever the draft changes while the review is open.
  useEffect(() => {
    if (!open || info.state === 'none') return undefined
    let current = true
    setFailure(null)
    compare().then(
      (answer) => {
        if (current) setComparison(answer)
      },
      (error: unknown) => {
        if (current) setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      current = false
    }
  }, [compare, info.revision, info.state, open])

  const rows = useMemo(() => (comparison ? changeRows(comparison.summary) : []), [comparison])
  const summary = comparison?.summary
  const decide = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <RightSheet
      open={open && info.state !== 'none'}
      onClose={onClose}
      title={t('kitEditor.draft.reviewTitle')}
      footer={
        <div className="kit-draft-review__footer">
          <p>{t('kitEditor.draft.localHint')}</p>
          <div className="kit-draft-review__actions">
            <Button variant="outline" size="md" type="button" disabled={busy} onClick={() => void decide(onDiscard)} data-testid="kit-draft-review-discard">
              <X />
              {t('kitEditor.draft.discard')}
            </Button>
            <Button size="md" type="button" disabled={busy || !comparison} onClick={() => void decide(onMerge)} data-testid="kit-draft-merge">
              <Check />
              {t('kitEditor.draft.merge')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="kit-draft-review" data-testid="kit-draft-review-panel">
        {failure ? (
          <p role="alert" className="kit-draft-review__failure">
            {t('kitEditor.draft.compareFailed')}: {failure}
          </p>
        ) : !comparison || !summary ? (
          <p className="kit-draft-review__loading">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('kitEditor.draft.comparing')}
          </p>
        ) : (
          <>
            <div className="kit-draft-review__sides">
              <Side label={t('kitEditor.draft.before')} png={comparison.before} testId="kit-draft-before" />
              <Side label={t('kitEditor.draft.after')} png={comparison.after} testId="kit-draft-after" />
            </div>
            <ul className="kit-draft-review__counts" data-testid="kit-draft-summary">
              <li>{t('kitEditor.draft.created', { count: summary.created.length })}</li>
              <li>{t('kitEditor.draft.changed', { count: summary.changed.length })}</li>
              <li>{t('kitEditor.draft.deleted', { count: summary.deleted.length })}</li>
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
            {summary.texts.length ? (
              <section className="kit-draft-review__texts">
                <h3>{t('kitEditor.draft.texts')}</h3>
                {summary.texts.slice(0, LISTED).map((text) => (
                  <div key={`${text.id}-${text.field}`} className="kit-draft-review__text">
                    {text.before ? <del>{clip(text.before)}</del> : null}
                    {text.after ? <ins>{clip(text.after)}</ins> : null}
                  </div>
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </RightSheet>
  )
}

/** How a merged draft is recorded: the agent's edit, on behalf of the person in this window (A11). */
const DRAFT_MERGE_ORIGIN: DraftOrigin = { kind: 'agent', principal: 'user:local', label: "Merged the agent's draft" }

/** The kit's KDM schema, which a kit whose engine does not describe its own needs to merge a draft. */
async function kitSchema(kitId: string) {
  const [{ kitDescriptor }] = await Promise.all([import('@/lib/sdk/kits'), import('@/lib/sdk/kits/index')])
  return kitDescriptor(kitId)?.schema
}

/**
 * The agent's draft of the kit document open in `connection`: the banner above the kit, and the
 * review with the person's Merge and Discard (standard 2.0 A14).
 */
export function KitDraftControls({ connection, kitId, path, active }: { connection: KitConnection | null; kitId: string; path: string; active: boolean }) {
  const { t } = useTranslation('workspace')
  const draft = useKitDraft(path)
  const [reviewing, setReviewing] = useState(false)
  useEffect(() => {
    if (draft.state === 'none') setReviewing(false)
  }, [draft.state])
  const compare = useCallback(async () => {
    if (!connection) throw new Error(t('kitEditor.opening'))
    return connection.draft.compare({ maxSize: 640, schema: await kitSchema(kitId) })
  }, [connection, kitId, t])
  const merge = useCallback(async () => {
    if (!connection) return
    try {
      await connection.draft.merge(DRAFT_MERGE_ORIGIN, await kitSchema(kitId))
      setReviewing(false)
      notify.success(t('kitEditor.draft.merged'), { description: t('kitEditor.draft.mergedHint') })
    } catch (error) {
      notify.error(t('kitEditor.draft.mergeFailed'), { description: error instanceof Error ? error.message : String(error) })
    }
  }, [connection, kitId, t])
  const discard = useCallback(async () => {
    if (!connection) return
    try {
      await connection.draft.discard()
      setReviewing(false)
      notify.info(t('kitEditor.draft.discarded'))
    } catch (error) {
      notify.error(t('kitEditor.draft.discardFailed'), { description: error instanceof Error ? error.message : String(error) })
    }
  }, [connection, t])
  if (!connection) return null
  return (
    <>
      <KitDraftBanner info={draft} onReview={() => setReviewing(true)} onDiscard={() => void discard()} />
      <KitDraftReviewSheet open={reviewing && active} info={draft} compare={compare} onMerge={merge} onDiscard={discard} onClose={() => setReviewing(false)} />
    </>
  )
}
