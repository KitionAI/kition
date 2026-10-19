import { useTranslation } from 'react-i18next'
import { useKitDraft } from './kitDrafts'

/** On a document tab: the agent has a draft of this kit document (open, or ready for review). */
export function KitDraftTabMark({ path }: { path: string | null }) {
  const { t } = useTranslation('workspace')
  const draft = useKitDraft(path)
  if (draft.state === 'none') return null
  const label = draft.state === 'ready' ? t('kitEditor.draft.tabReady') : t('kitEditor.draft.tabOpen')
  return (
    <span className="document-tab-draft-mark" data-testid="document-tab-draft" data-state={draft.state} title={label} aria-label={label}>
      {t('kitEditor.draft.tab')}
    </span>
  )
}
