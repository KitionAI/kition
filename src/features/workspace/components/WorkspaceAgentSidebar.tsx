import { useWorkspaceImageGeneration } from '../hooks/useWorkspaceImageGeneration'
import type { AgentTurnContext } from '@/features/agent/lib/agentTurnContext'
import type { AgentImageSessionEvent } from '@/features/agent/lib/agentImageJobs'
import { Bot } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentChatPanel } from '@/features/agent/components/AgentChatPanel'

export function WorkspaceAgentSidebar({
  panelProps, rootPath = '', imageContext, imageEvents = [],
}: {
  panelProps: ComponentProps<typeof AgentChatPanel> | null
  rootPath?: string
  imageContext?: AgentTurnContext
  imageEvents?: AgentImageSessionEvent[]
}) {
  const { t } = useTranslation('workspace')
  const imageGeneration = useWorkspaceImageGeneration(rootPath, imageContext)
  return (
    <aside className="workspace-agent-sidebar">
      <div className="workspace-agent-sidebar-body">
        {panelProps ? (
          <AgentChatPanel key={`${rootPath}:${panelProps.session.id}`} {...panelProps} imageGeneration={{ ...imageGeneration, events: imageEvents }} />
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
