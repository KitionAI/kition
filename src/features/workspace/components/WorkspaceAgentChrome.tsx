import type { AgentSession } from '@/api/agent'
import { AgentFloatingLauncher } from '@/features/agent/public'
import { WorkspaceAgentTabBar } from '@/features/workspace/components/WorkspaceAgentTabBar'
import type { useWorkspaceAgentPanel } from '@/features/workspace/hooks/useWorkspaceAgentPanel'
import { selectItemsToClose, type CloseScope } from '@/features/workspace/state/closeScope'

export type WorkspaceAgentPanelState = ReturnType<typeof useWorkspaceAgentPanel>

type WorkspaceAgentChromeProps = {
  /** Topbar slot the chat tab bar renders into. */
  portal: HTMLElement | null
  panel: WorkspaceAgentPanelState
  sessions: AgentSession[]
}

/** Text copied by "Copy reference" on a chat tab. */
export function agentSessionReference(session: Pick<AgentSession, 'id' | 'title'>) {
  return session.title || `Chat #${session.id}`
}

/** The Agent's chrome outside its pane: the chat tab bar in the topbar and the floating launcher when the pane is closed. */
export function WorkspaceAgentChrome({ portal, panel, sessions }: WorkspaceAgentChromeProps) {
  const closeSessions = (sessionId: number | null, scope: CloseScope) =>
    panel.closeSessions(selectItemsToClose(panel.openSessions, sessionId, scope).map((session) => session.id))

  return (
    <>
      <WorkspaceAgentTabBar
        portal={portal}
        open={panel.open}
        activeSessionId={panel.activeSession?.id || null}
        sessions={sessions}
        openSessions={panel.openSessions}
        historyOpen={panel.historyOpen}
        onToggleOpen={panel.toggle}
        onCreateSession={() => void panel.createChat()}
        onCloseSession={(session) => panel.closeSessions([session.id])}
        onCloseOtherSessions={(session) => closeSessions(session.id, 'others')}
        onCloseAllSessions={() => closeSessions(null, 'all')}
        onCloseLeftSessions={(session) => closeSessions(session.id, 'left')}
        onCloseRightSessions={(session) => closeSessions(session.id, 'right')}
        onCopySessionRef={(session) => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(agentSessionReference(session))
          }
        }}
        onSelectSession={(session) => panel.showSession(session.id)}
        onToggleHistory={() => panel.setHistoryOpen((current) => !current)}
      />
      <AgentFloatingLauncher visible={!panel.open} onOpen={panel.toggle} />
    </>
  )
}
