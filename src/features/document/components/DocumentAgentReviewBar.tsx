import { Bot, Check, FileDiff, X } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { DocumentAgentReview } from '@/features/document/kdm/documentSession'
import { createDocumentRevisionComparison } from '@/features/document/lib/documentRevision'
import { Button } from '@/registry/ui/button'

type DocumentAgentReviewBarProps = {
  review: DocumentAgentReview
  onAccept: () => void
  onReject: () => void
  /** Opens the review panel to decide change by change. */
  onShowChanges: () => void
}

/**
 * Above the text of a document the agent just edited: the edit is in the text already, marked;
 * Accept keeps it, Reject takes it back (the person's typing since stays).
 */
export function DocumentAgentReviewBar({ review, onAccept, onReject, onShowChanges }: DocumentAgentReviewBarProps) {
  const { t } = useTranslation('document')
  const count = useMemo(
    () => createDocumentRevisionComparison(review.before, review.after).changes.length,
    [review.before, review.after],
  )
  return (
    <div className="document-revision-toolbar document-agent-review-bar" data-testid="document-agent-review" role="region" aria-label={t('agentReview.title')}>
      <div className="document-revision-toolbar__summary">
        <span className="document-revision-toolbar__icon" aria-hidden="true">
          <Bot />
        </span>
        <span className="min-w-0">
          <strong>{t('agentReview.title')}</strong>
          <span>{t('agentReview.summary', { count })}</span>
        </span>
      </div>
      <div className="document-revision-toolbar__actions">
        <Button variant="ghost" size="md" type="button" onClick={onShowChanges}>
          <FileDiff />
          {t('revision.title')}
        </Button>
        <Button variant="outline" size="md" type="button" onClick={onReject}>
          <X />
          {t('revision.rejectAll')}
        </Button>
        <Button size="md" type="button" onClick={onAccept}>
          <Check />
          {t('revision.acceptAll')}
        </Button>
      </div>
    </div>
  )
}
