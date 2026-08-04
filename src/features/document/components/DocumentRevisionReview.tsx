import { Check, ChevronDown, ChevronUp, FileDiff, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildDocumentRevisionDisplayBlocks,
  type DocumentRevisionDecision,
  type DocumentRevisionDisplayLine,
  type PendingDocumentRevision,
} from '@/features/document/lib/documentRevision'
import { Button } from '@/registry/ui/button'
import { cn } from '@/lib/utils'

type DocumentRevisionReviewProps = {
  revision: PendingDocumentRevision
  saving: boolean
  titleSlot?: ReactNode
  onDecideChange: (changeId: string, decision: DocumentRevisionDecision) => void
  onResolveAll: (decision: DocumentRevisionDecision) => void
}

export function DocumentRevisionReview({
  revision,
  saving,
  titleSlot,
  onDecideChange,
  onResolveAll,
}: DocumentRevisionReviewProps) {
  const { t } = useTranslation('document')
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [activePendingIndex, setActivePendingIndex] = useState(0)
  const pendingChanges = useMemo(
    () => revision.comparison.changes.filter((change) => !revision.decisions[change.id]),
    [revision],
  )
  const displayBlocks = useMemo(
    () => buildDocumentRevisionDisplayBlocks(revision.comparison),
    [revision.comparison],
  )

  useEffect(() => {
    setActivePendingIndex((current) => Math.min(current, Math.max(0, pendingChanges.length - 1)))
  }, [pendingChanges.length])

  function scrollPendingChangeIntoView(changeId: string) {
    const scroller = scrollerRef.current
    const target = scroller?.querySelector<HTMLElement>(
      `[data-revision-change-id="${changeId}"]`,
    )
    if (!scroller || !target) return

    const scrollerRect = scroller.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const centeredOffset = Math.max(0, (scrollerRect.height - targetRect.height) / 2)
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop + targetRect.top - scrollerRect.top - centeredOffset,
    )
  }

  function navigatePendingChange(offset: number) {
    if (!pendingChanges.length) return
    const nextIndex = (activePendingIndex + offset + pendingChanges.length) % pendingChanges.length
    setActivePendingIndex(nextIndex)
    scrollPendingChangeIntoView(pendingChanges[nextIndex].id)
  }

  return (
    <div className="document-revision-review" data-testid="document-revision-review">
      <div className="document-revision-toolbar">
        <div className="document-revision-toolbar__summary">
          <span className="document-revision-toolbar__icon" aria-hidden="true">
            <FileDiff />
          </span>
          <span className="min-w-0">
            <strong>{t('revision.title')}</strong>
            <span>{t('revision.summary', { count: revision.comparison.changes.length })}</span>
          </span>
        </div>
        <div className="document-revision-toolbar__actions">
          <span className="document-revision-toolbar__pending">
            {t('revision.pending', { count: pendingChanges.length })}
          </span>
          <Button
            variant="outline"
            size="iconSm"
            type="button"
            disabled={saving || !pendingChanges.length}
            onClick={() => navigatePendingChange(-1)}
            label={t('revision.previous')}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="outline"
            size="iconSm"
            type="button"
            disabled={saving || !pendingChanges.length}
            onClick={() => navigatePendingChange(1)}
            label={t('revision.next')}
          >
            <ChevronDown />
          </Button>
          <Button
            variant="outline"
            size="md"
            type="button"
            disabled={saving}
            onClick={() => onResolveAll('rejected')}
          >
            <X />
            {t('revision.rejectAll')}
          </Button>
          <Button
            size="md"
            type="button"
            loading={saving}
            disabled={saving}
            onClick={() => onResolveAll('accepted')}
          >
            <Check />
            {t('revision.acceptAll')}
          </Button>
        </div>
      </div>
      <div ref={scrollerRef} className="document-revision-review__scroller">
        {titleSlot ? (
          <div className="document-title-row document-revision-title-row">
            <div className="document-title-row__title">{titleSlot}</div>
          </div>
        ) : null}
        <div className="document-revision-content">
          {displayBlocks.map((block, blockIndex) => {
            if (block.kind === 'equal') {
              return (
                <div key={`equal-${blockIndex}`} className="document-revision-lines">
                  {block.lines.map((line, lineIndex) => (
                    <DocumentRevisionLine
                      key={`equal-${blockIndex}-${lineIndex}`}
                      line={line}
                    />
                  ))}
                </div>
              )
            }

            const { change } = block
            const decision = revision.decisions[change.id]
            const changeIndex = revision.comparison.changes.findIndex((item) => item.id === change.id)
            const visibleLines = decision === 'accepted'
              ? block.lines.filter((line) => line.kind === 'added')
              : decision === 'rejected'
                ? block.lines.filter((line) => line.kind === 'removed')
                : block.lines
            return (
              <section
                key={change.id}
                className={cn(
                  'document-revision-change-block',
                  decision === 'accepted' && 'is-accepted',
                  decision === 'rejected' && 'is-rejected',
                )}
                data-revision-change-id={change.id}
                data-testid={`document-revision-change-${change.id}`}
              >
                <div className="document-revision-change-actions">
                  <span className="document-revision-change-actions__label">
                    {t('revision.changeLabel', { index: changeIndex + 1 })}
                  </span>
                  {decision ? (
                    <span className={cn('document-revision-change-actions__status', `is-${decision}`)}>
                      {decision === 'accepted' ? t('revision.accepted') : t('revision.rejected')}
                    </span>
                  ) : null}
                  <span className="document-revision-change-actions__metrics" aria-hidden="true">
                    <span className="is-removed">−{change.oldText.length}</span>
                    <span className="is-added">+{change.newText.length}</span>
                  </span>
                  <Button
                    variant="outline"
                    size="iconSm"
                    type="button"
                    disabled={saving}
                    className={cn(decision === 'rejected' && 'is-selected-reject')}
                    onClick={() => onDecideChange(change.id, 'rejected')}
                    label={t('revision.reject')}
                  >
                    <X />
                  </Button>
                  <Button
                    variant="outline"
                    size="iconSm"
                    type="button"
                    disabled={saving}
                    className={cn(decision === 'accepted' && 'is-selected-accept')}
                    onClick={() => onDecideChange(change.id, 'accepted')}
                    label={t('revision.accept')}
                  >
                    <Check />
                  </Button>
                </div>
                <div className="document-revision-lines">
                  {visibleLines.map((line, lineIndex) => (
                    <DocumentRevisionLine
                      key={`${change.id}-${line.kind}-${lineIndex}`}
                      line={line}
                      decision={decision}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function DocumentRevisionLine({
  line,
  decision,
}: {
  line: DocumentRevisionDisplayLine
  decision?: DocumentRevisionDecision
}) {
  const resolved = Boolean(decision)
  const lineNumber = line.kind === 'removed'
    ? line.oldLineNumber
    : line.newLineNumber ?? line.oldLineNumber
  return (
    <div
      className={cn(
        'document-revision-line',
        !resolved && `is-${line.kind}`,
        decision && `is-${decision}`,
      )}
    >
      <span className="document-revision-line__number" aria-hidden="true">
        {lineNumber ?? ''}
      </span>
      <span className="document-revision-line__marker" aria-hidden="true">
        {!resolved && line.kind === 'removed' ? '−' : null}
        {!resolved && line.kind === 'added' ? '+' : null}
      </span>
      <code className="document-revision-line__text">{line.text || ' '}</code>
    </div>
  )
}
