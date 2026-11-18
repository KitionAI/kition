import { BotIcon as Bot } from '@kition/tessera-icons/react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentChatPanel } from '@/features/agent/components/AgentChatPanel'

export function WorkspaceAgentSidebar({
  panelProps, rootPath = '',
}: {
  panelProps: ComponentProps<typeof AgentChatPanel> | null
  rootPath?: string
}) {
  const { t } = useTranslation('workspace')
  return (
    <aside className="workspace-agent-sidebar">
      <div className="workspace-agent-sidebar-body">
        {panelProps ? (
          <AgentChatPanel key={`${rootPath}:${panelProps.session.id}`} {...panelProps} />
        ) : (
          <div className="workspace-agent-sidebar-empty is-body">
            <Bot className="size-5" />
            <span>{t('agentSidebar.empty')}</span>
          </div>
        )}
      </div>
    </aside>
  )
}
