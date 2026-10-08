import { useTranslation } from 'react-i18next'
import type { DocumentRevisionChange, DocumentRevisionDecision } from '@/features/document/lib/documentRevision'

type Props = {
  change: DocumentRevisionChange
  decision?: DocumentRevisionDecision
}

/** Keep the original token boundaries so long paragraphs expose small edits. */
export function DocumentRevisionComparison({ change, decision }: Props) {
  const { t } = useTranslation('document')
  const sides = decision === 'accepted' ? ['added'] as const
    : decision === 'rejected' ? ['removed'] as const
      : ['removed', 'added'] as const
  return (
    <div className="document-revision-comparison" data-resolved={Boolean(decision)}>
      {sides.map((side) => {
        const parts = change.parts.filter((part) => part.kind === 'equal' || part.kind === side)
        const hasContent = parts.some((part) => part.text.length > 0)
        return (
          <div className={`document-revision-comparison__side is-${side}`} key={side}>
            <div className="document-revision-comparison__label">
              <span aria-hidden="true">{side === 'removed' ? '−' : '+'}</span>
              {t(side === 'removed' ? 'revision.original' : 'revision.proposed')}
            </div>
            <div className="document-revision-comparison__text">
              {hasContent ? parts.map((part, index) => (
                part.kind === 'equal' || decision
                  ? <span key={index}>{part.text}</span>
                  : <mark className={`is-${part.kind}`} key={index}>{part.text}</mark>
              )) : <span className="document-revision-comparison__empty">{t('revision.empty')}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
