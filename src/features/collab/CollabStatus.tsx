import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
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

/** Shown on a shared document this person may only view, or only comment on. */
function AccessBadge({ role }: { role: 'viewer' | 'commenter' }) {
  const { t } = useTranslation('workspace')
  return (
    <span className="collab-view-only" data-testid={role === 'viewer' ? 'collab-view-only' : 'collab-comment-only'}>
      {t(role === 'viewer' ? 'collab.viewOnly' : 'collab.commentOnly')}
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
      {collab.role === 'viewer' || collab.role === 'commenter' ? <AccessBadge role={collab.role} /> : null}
      <PresenceAvatars peers={collab.peers} />
    </span>
  )
}
