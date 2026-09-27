import { lazy, Suspense, type ComponentProps } from 'react'

import type { getKitionAccountLinks, useKitionAccount } from '@/features/account/public'
import type { AgentTurnContext, useWorkspaceAgent } from '@/features/agent/public'
import type { WorkspaceAgentSidebar as WorkspaceAgentSidebarComponent } from '@/features/workspace/components/WorkspaceAgentSidebar'
import { deriveAgentPaneContext } from '@/features/workspace/lib/agentPaneContext'
import { formatWorkspaceTime, type WorkspaceTab } from '@/features/workspace/lib/workspace'
import { isDesktopRuntime, openExternalURL } from '@/services/desktop'
import type { AgentImageGenerationIntent } from '@/types/imageGeneration'

const WorkspaceAgentSidebar = lazy(() =>
  import('@/features/workspace/components/WorkspaceAgentSidebar').then((module) => ({ default: module.WorkspaceAgentSidebar })),
)

type WorkspaceAgent = ReturnType<typeof useWorkspaceAgent>
type PanelProps = NonNullable<ComponentProps<typeof WorkspaceAgentSidebarComponent>['panelProps']>

export type WorkspaceAgentPaneProps = {
  rootPath: string
  agent: WorkspaceAgent
  session: WorkspaceAgent['agentSessions'][number] | null
  imageContext: AgentTurnContext
  activeWorkspaceTab: WorkspaceTab | undefined
  activeWorkspaceDocumentPath: string
  documentContextPaths: string[]
  /** The design editor supplies its own empty-state copy for the chat. */
  designEmptyState?: PanelProps['emptyStateOverride']
  kitionAccount: ReturnType<typeof useKitionAccount>
  kitionAccountLinks: ReturnType<typeof getKitionAccountLinks>
  onOpenSettingsSection?: (section: 'models') => void
  onAddLocalSource: () => void
  onSend: (sessionId: number, intent?: AgentImageGenerationIntent) => void
  onOpenDocument: (path: string) => void
  onReviewModifiedArtifact: (path: string) => void
  /** Imports dropped files as attachments and resolves to their workspace paths. */
  onImportFiles: (files: File[], target: 'attachments') => Promise<string[]>
}

/**
 * The Agent sidebar for the active session: wires the chat panel to the
 * session's messages, tool calls, events, drafts, artifacts, and local
 * sources, plus the model and hosted-account controls. Renders nothing when
 * no session is active so the sidebar can show its empty state.
 */
export function WorkspaceAgentPane({
  rootPath,
  agent,
  session,
  imageContext,
  activeWorkspaceTab,
  activeWorkspaceDocumentPath,
  documentContextPaths,
  designEmptyState,
  kitionAccount,
  kitionAccountLinks,
  onOpenSettingsSection,
  onAddLocalSource,
  onSend,
  onOpenDocument,
  onReviewModifiedArtifact,
  onImportFiles,
}: WorkspaceAgentPaneProps) {
  const panelProps: PanelProps | null = session
    ? {
      session,
      messages: agent.agentMessages[session.id] || [],
      toolCalls: agent.agentToolCalls[session.id] || [],
      events: agent.agentEvents[session.id] || [],
      draft: agent.agentDrafts[session.id] || '',
      streamingText: agent.agentStreamingText[session.id] || '',
      artifacts: agent.agentArtifacts[session.id] || [],
      busy: agent.agentBusySessions.has(session.id),
      currentDocumentPath: activeWorkspaceDocumentPath,
      modelOptions: agent.agentModelOptions,
      selectedModelKey: agent.resolvedAgentModelKey,
      needsModelConfig: !agent.selectedAgentModel?.runtimeModel,
      hostedAccountStatus: agent.selectedAgentModel?.providerKind === 'kition_console'
        ? kitionAccount.state.status
        : undefined,
      mentionableDocuments: agent.mentionableDocuments,
      documentContextPaths,
      localSources: agent.agentLocalSources[session.id] || [],
      formatTime: formatWorkspaceTime,
      onDraftChange: (value: string) => agent.setAgentDraft(session.id, value),
      onAddLocalSource,
      onAddDocumentContext: (path: string) => agent.addAgentDocumentContext(session.id, path, activeWorkspaceDocumentPath),
      onRemoveDocumentContext: (path: string) => agent.removeAgentDocumentContext(session.id, path),
      onRemoveLocalSource: (sourceId: string) => agent.removeAgentLocalSource(session.id, sourceId),
      onSend: (intent) => onSend(session.id, intent),
      onStop: () => agent.stopAgentMessage(session.id),
      onConfigureModel: onOpenSettingsSection ? () => onOpenSettingsSection('models') : () => {},
      onHostedAccountConnect: () => void kitionAccount.ensureReady(),
      onHostedAccountCancel: kitionAccount.cancelConnect,
      onHostedAccountBilling: () => void openExternalURL(kitionAccountLinks.topup),
      onModelChange: (value: string) => void agent.handleAgentModelChange(value),
      onOpenArtifact: onOpenDocument,
      onReviewModifiedArtifact,
      onShellApprovalDecision: (request, decision) => agent.respondToAgentShellApproval(session.id, request, decision),
      onImportFiles: isDesktopRuntime() ? (files) => onImportFiles(files, 'attachments') : undefined,
      onApplyPlan: (plan) => agent.sendAgentContextAction(session.id, {
        content: 'Please execute the current write task directly using the confirmed table plan, writing the rows to the table now.',
        executionMode: 'apply',
        tablePlanContext: plan,
      }),
      // Same mapping as the Agent's system prompt so the empty-state copy
      // matches the pane the user is looking at before the first message.
      paneContext: deriveAgentPaneContext(activeWorkspaceTab),
      emptyStateOverride: activeWorkspaceTab?.type === 'design' ? designEmptyState : undefined,
    }
    : null

  return (
    <Suspense fallback={null}>
      <WorkspaceAgentSidebar
        rootPath={rootPath}
        imageContext={imageContext}
        imageEvents={agent.agentImageGenerationEvents[session?.id || 0] || []}
        panelProps={panelProps}
      />
    </Suspense>
  )
}
