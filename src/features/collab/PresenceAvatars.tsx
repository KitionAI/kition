import { useTranslation } from 'react-i18next'
import type { Presence } from '@/lib/sync'
import { isAgentPeer } from './collabStore'

const SHOWN = 3

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** The other people editing a shared document, and the agents editing it, as small avatars on its tab. */
export function PresenceAvatars({ peers }: { peers: Presence[] }) {
  const { t } = useTranslation('workspace')
  if (!peers.length) return null
  const names = peers.map((peer) => (isAgentPeer(peer) ? t('collab.agentPeer') : peer.name)).join(', ')
  return (
    <span className="collab-presence" role="img" aria-label={t('collab.peers', { names })} title={t('collab.peers', { names })} data-testid="collab-presence">
      {peers.slice(0, SHOWN).map((peer) => (
        <span
          key={peer.principalId}
          className={isAgentPeer(peer) ? 'collab-presence-avatar collab-presence-avatar--agent' : 'collab-presence-avatar'}
          style={{ backgroundColor: peer.color }}
          data-testid="collab-peer"
          data-peer={peer.name}
          data-agent={isAgentPeer(peer) ? 'true' : undefined}
        >
          {initials(peer.name)}
        </span>
      ))}
      {peers.length > SHOWN ? <span className="collab-presence-more">+{peers.length - SHOWN}</span> : null}
    </span>
  )
}
