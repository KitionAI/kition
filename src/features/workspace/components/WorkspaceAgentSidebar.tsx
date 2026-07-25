import { Bot } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentChatPanel } from '@/features/agent/components/AgentChatPanel'

export function WorkspaceAgentSidebar({
  panelProps,
}: {
  panelProps: ComponentProps<typeof AgentChatPanel> | null
}) {
  const { t } = useTranslation('workspace')
  return (
    <aside className="workspace-agent-sidebar">
      <div className="workspace-agent-sidebar-body">
        {panelProps ? (
          <AgentChatPanel {...panelProps} />
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
