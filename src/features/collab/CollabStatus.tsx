import { useTranslation } from 'react-i18next'
import { cn } from '@kition/app-ui/utils'
import { useDocumentCollab } from './collabStore'
import { PresenceAvatars } from './PresenceAvatars'
import { useCollabConnectionState, type CollabConnectionState } from './syncConnection'

/** Whether a shared document is connected to its room: a dot with the state as its label. */
function CollabStatus({ state }: { state: CollabConnectionState }) {
  const { t } = useTranslation('workspace')
  const shown = state === 'off' ? 'offline' : state
  const label = t(`collab.status.${shown}`)
  return <span className={cn('collab-status', `is-${shown}`)} role="status" aria-label={label} title={label} data-testid="collab-status" data-state={shown} />
}

/** Shown on a shared document this person may only view. */
function ViewOnlyBadge() {
  const { t } = useTranslation('workspace')
  return (
    <span className="collab-view-only" data-testid="collab-view-only">
      {t('collab.viewOnly')}
    </span>
  )
}

/** A tab's co-editing indicators: nothing for a document that is not shared. */
export function CollabTabIndicators({ path }: { path: string }) {
  const collab = useDocumentCollab(path)
  const state = useCollabConnectionState()
  if (!collab) return null
  return (
    <span className="collab-tab-indicators" data-testid="collab-tab-indicators">
      <CollabStatus state={state} />
      {collab.role === 'viewer' ? <ViewOnlyBadge /> : null}
      <PresenceAvatars peers={collab.peers} />
    </span>
  )
}
