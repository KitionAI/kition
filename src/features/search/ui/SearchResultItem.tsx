// src/features/search/ui/SearchResultItem.tsx
import { useTranslation } from 'react-i18next'
import type { SearchHit } from '../types'
import { renderSnippet } from './renderSnippet'

export function SearchResultItem({ hit, onClick }: { hit: SearchHit; onClick: () => void }) {
  const { t } = useTranslation('settings')
  const doc = hit.doc
                                                
  let source: string
  if (doc.kind === 'note') {
    const dir = doc.vaultPath.includes('/') ? doc.vaultPath.slice(0, doc.vaultPath.lastIndexOf('/')) : ''
    const folder = dir.split('/').filter(Boolean).pop()
    source = folder || t('search.groups.document')
  } else if (doc.kind === 'kitable_record') {
    source = t('search.groups.record')
  } else {
    source = t('search.groups.fieldsViews')
  }
  return (
    <button className="search-result-item" data-testid="search-result-item" onClick={onClick}>
      <span className="search-result-head">
        <span className="search-result-title">{doc.title || doc.vaultPath}</span>
        <span className="search-result-source">{source}</span>
      </span>
      <span className="search-result-snippet"
        dangerouslySetInnerHTML={{ __html: renderSnippet(doc.body, hit.matches) }} />
    </button>
  )
}
