import { AgentImageComposerControls, AgentImageComposerSummary } from './AgentImageComposerControls'
import { useAgentImageMode } from '../hooks/useAgentImageMode'
import type { AgentImageSessionEvent } from '../lib/agentImageJobs'
import type { AgentImageGenerationIntent, AgentImageTarget } from '@/types/imageGeneration'
import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentArtifact, AgentEvent, AgentLocalSource, AgentMessage, AgentSession,
  AgentShellApprovalDecision, AgentShellApprovalRequest, AgentTablePlanContext, AgentToolCall,
} from '@/api/agent'
import { KitionLogoMark } from '@/components/KitionLogoMark'
import { AgentAiComposer } from './AgentAiComposer'
import { AgentChangedFilesCard, AgentConversation } from './AgentConversation'
import { AgentContextCards } from './AgentContextCards'
import { AgentPanelEmptyState } from './AgentPanelChrome'
import type { KitionAccountStatus } from '@/features/account/hooks/useKitionAccount'
import { isKitionAccountUsable } from '@/features/account/lib/accountState'
import type { AgentMentionableDocument } from '@/features/agent/lib/documentMentions'
import { type AgentPaneContext, emptyStateForPane } from '@/features/agent/lib/paneEmptyState'
import type { AgentModelOption } from '@/features/agent/lib/agentConfig'
import { cn } from '@/lib/utils'

type AgentChatPanelProps = {
  session: AgentSession
  messages: AgentMessage[]
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  draft: string
  streamingText: string
  artifacts: AgentArtifact[]
  busy: boolean
  currentDocumentPath?: string
  modelOptions: AgentModelOption[]
  selectedModelKey: string
  needsModelConfig: boolean
  hostedAccountStatus?: KitionAccountStatus
  mentionableDocuments?: AgentMentionableDocument[]
  documentContextPaths?: string[]
  localSources?: AgentLocalSource[]
  formatTime: (value?: string | null) => string
  onDraftChange: (value: string) => void
  onAddLocalSource?: () => void
  onAddDocumentContext?: (path: string) => void
  onRemoveDocumentContext?: (path: string) => void
  onRemoveLocalSource?: (sourceId: string) => void
  imageGeneration?: {
    available: boolean
    accessToken?: string
    target?: AgentImageTarget
    events: AgentImageSessionEvent[]
  }
  onSend: (intent?: AgentImageGenerationIntent) => void
  onStop: () => void
  onConfigureModel: () => void
  onHostedAccountConnect?: () => void
  onHostedAccountCancel?: () => void
  onHostedAccountBilling?: () => void
  onModelChange: (value: string) => void
  onOpenArtifact: (path: string) => void
  onReviewModifiedArtifact?: (path: string) => void
  onApplyPlan?: (plan: AgentTablePlanContext) => void
  onShellApprovalDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
  onImportFiles?: (files: File[]) => Promise<string[]>
  /** Active workbench pane the agent sits next to. Drives the
   *  empty-state copy so the suggestion prompts match what the user is
   *  actually looking at — "Summarize this document" makes no sense
   *  when the right pane is a workflow editor or table view. Defaults
   *  to 'document' to keep behaviour unchanged for legacy mounts. */
  paneContext?: AgentPaneContext
  /** Client-only welcome copy for surfaces that do not yet publish runtime context. */
  emptyStateOverride?: ReturnType<typeof emptyStateForPane>
  /** Optional slot rendered after the messages list, before the composer. */
  progressCard?: ReactNode
}

export function AgentChatPanel({
  session,
  messages,
  toolCalls,
  events,
  draft,
  streamingText,
  artifacts,
  busy,
  currentDocumentPath = '',
  modelOptions,
  selectedModelKey,
  needsModelConfig,
  hostedAccountStatus,
  mentionableDocuments = [],
  documentContextPaths = [],
  localSources = [],
  onDraftChange,
  onAddLocalSource,
  onAddDocumentContext,
  onRemoveDocumentContext,
  onRemoveLocalSource,
  onSend,
  onStop,
  onConfigureModel,
  onHostedAccountConnect,
  onHostedAccountCancel,
  onHostedAccountBilling,
  onModelChange,
  onOpenArtifact,
  onReviewModifiedArtifact,
  onApplyPlan,
  onShellApprovalDecision,
  onImportFiles,
  paneContext = 'document',
  emptyStateOverride,
  progressCard,
  imageGeneration,
}: AgentChatPanelProps) {
  const hostedAccountBusy = hostedAccountStatus === 'loading' || hostedAccountStatus === 'connecting'
  const hostedAccountBlocked = Boolean(hostedAccountStatus && !isKitionAccountUsable(hostedAccountStatus))
  const hostedAccountCreditsEmpty = hostedAccountStatus === 'credits_empty'
  const canSend = !busy && !hostedAccountBusy && !hostedAccountCreditsEmpty
  const imageMode = useAgentImageMode({
    sessionId: session.id, target: imageGeneration?.target,
    available: Boolean(imageGeneration?.available), accessToken: imageGeneration?.accessToken,
    referencePaths: documentContextPaths.filter((path) => /\.(png|jpe?g|webp)$/i.test(path)),
    draft, busy, canSend: canSend && !needsModelConfig, onDraftChange, onSend,
  })
  const composerCanSend = canSend && !imageMode.preparing && (imageMode.enabled
    ? Boolean(imageMode.instruction) && !imageMode.blockedReason
    : draft.trim().length > 0)
  const sendComposer = () => { if (composerCanSend && !needsModelConfig) void imageMode.send() }

  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const followLatestRef = useRef(true)
  const previousLatestMessageIdRef = useRef<number | null>(null)

  useEffect(() => {
    const latestMessage = messages[messages.length - 1]
    if (
      latestMessage?.role === 'user'
      && latestMessage.id !== previousLatestMessageIdRef.current
    ) {
      followLatestRef.current = true
    }
    previousLatestMessageIdRef.current = latestMessage?.id ?? null

    if (!followLatestRef.current) {
      return
    }
    const container = messagesContainerRef.current
    if (!container) {
      return
    }
    container.scrollTop = container.scrollHeight
  }, [artifacts, busy, events, imageGeneration?.events, messages, streamingText, toolCalls])

  function handleMessagesScroll() {
    const container = messagesContainerRef.current
    if (!container) {
      return
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    followLatestRef.current = distanceFromBottom <= 48
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as KeyboardEvent
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return
    }
    if (event.key !== 'Enter') {
      return
    }
    if (event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      const textarea = event.currentTarget
      const selectionStart = textarea.selectionStart
      const selectionEnd = textarea.selectionEnd
      const nextDraft = [
        textarea.value.slice(0, selectionStart),
        textarea.value.slice(selectionEnd),
      ].join('\n')
      onDraftChange(nextDraft)
      window.requestAnimationFrame(() => {
        textarea.focus()
        textarea.setSelectionRange(selectionStart + 1, selectionStart + 1)
      })
      return
    }
    event.preventDefault()
    if (composerCanSend) {
      sendComposer()
    }
  }

  // request_user_input interrupt → reuse the chat composer's send path so the
  // user's answer goes through the same message pipeline as a normal reply.
  // Codex parity §5: the runtime resumes the loop only after a fresh user
  // message lands.
  function handleAwaitUserInputSubmit(answer: string) {
    onDraftChange(answer)
    onSend()
  }

  const isEmptyChat = !messages.length && !streamingText
  const { t } = useTranslation('agent')

  return (
    <div className={cn('agent-chat-panel', isEmptyChat && 'is-empty')}>
      <div
        ref={messagesContainerRef}
        className={cn('agent-chat-messages', isEmptyChat && 'is-empty')}
        data-testid="agent-chat-messages"
        onScroll={handleMessagesScroll}
      >
        {isEmptyChat ? (() => {
          const emptyState = emptyStateOverride ?? emptyStateForPane(paneContext, t)
          // When no model is configured the send button is disabled, so
          // letting users click a suggestion card just fills the composer
          // with a prompt they can't send — they're stuck staring at
          // text they didn't type. Swap the suggestion grid for a single
          // "Configure a model" CTA so the empty state actually moves
          // them toward an unblocked state.
          return (
          <AgentPanelEmptyState
            icon={<KitionLogoMark className="size-10" />}
            title="Kition"
            description={emptyState.description}
            actions={needsModelConfig ? (
              <div className="agent-chat-suggestion-grid">
                <button
                  type="button"
                  className="agent-chat-suggestion-card"
                  onClick={onConfigureModel}
                  data-testid="agent-empty-configure-model"
                >
                  <span>{t('emptyState.needsModelConfig.label')}</span>
                </button>
              </div>
            ) : hostedAccountBlocked ? (
              <div className="agent-chat-suggestion-grid">
                <button
                  type="button"
                  className="agent-chat-suggestion-card"
                  onClick={hostedAccountCreditsEmpty
                    ? onHostedAccountBilling
                    : hostedAccountStatus === 'connecting'
                      ? onHostedAccountCancel
                      : onHostedAccountConnect}
                  disabled={hostedAccountStatus === 'loading'}
                  data-testid="agent-empty-kition-account"
                >
                  <span>{hostedAccountStatus === 'credits_empty'
                    ? t('emptyState.kitionAccount.topUp')
                    : hostedAccountStatus === 'loading'
                    ? t('emptyState.kitionAccount.checking')
                    : hostedAccountStatus === 'connecting'
                      ? t('emptyState.kitionAccount.cancel')
                      : hostedAccountStatus === 'temporary_error'
                        ? t('emptyState.kitionAccount.retry')
                        : hostedAccountStatus === 'expired'
                          ? t('emptyState.kitionAccount.signInAgain')
                        : t('emptyState.kitionAccount.signIn')}</span>
                </button>
              </div>
            ) : (
              <div className="agent-chat-suggestion-grid">
                {emptyState.suggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    className="agent-chat-suggestion-card"
                    onClick={() => onDraftChange(suggestion.prompt)}
                  >
                    <span>{suggestion.label}</span>
                  </button>
                ))}
              </div>
            )}
          />
          )
        })() : (
          <AgentConversation
            imageEvents={imageGeneration?.events}
            imageActions={imageGeneration ? {
              onEdit: imageMode.edit, onRetry: imageMode.retry, canRetry: imageMode.canRetry,
            } : undefined}
            messages={messages}
            toolCalls={toolCalls}
            events={events}
            artifacts={artifacts}
            busy={busy}
            streamingText={streamingText}
            onOpenPath={onOpenArtifact}
            onOpenArtifact={onOpenArtifact}
            onAwaitUserInputSubmit={handleAwaitUserInputSubmit}
            onShellApprovalDecision={onShellApprovalDecision}
          />
        )}
        {!isEmptyChat ? (
          <AgentContextCards
            events={events}
            busy={busy}
            onApplyPlan={onApplyPlan}
          />
        ) : null}
      </div>
      {progressCard ?? null}
      <div className="agent-chat-composer">
        <AgentChangedFilesCard
          toolCalls={toolCalls}
          artifacts={artifacts}
          onOpen={onReviewModifiedArtifact || onOpenArtifact}
        />
        <AgentAiComposer
          imageControls={imageGeneration ? <AgentImageComposerControls mode={imageMode} busy={busy}
            surface={paneContext === 'table' || paneContext === 'whiteboard' ? paneContext : 'document'}
            accessToken={imageGeneration.accessToken} /> : undefined}
          imageSummary={imageGeneration ? <AgentImageComposerSummary mode={imageMode} busy={busy} /> : undefined}
          busy={busy}
          canSend={composerCanSend}
          compact
          currentDocumentPath={currentDocumentPath}
          documentContextPaths={documentContextPaths}
          draft={draft}
          localSources={localSources}
          mentionableDocuments={mentionableDocuments}
          modelOptions={modelOptions}
          needsModelConfig={needsModelConfig}
          hostedAccountStatus={hostedAccountStatus}
          selectedModelKey={selectedModelKey}
          onConfigureModel={onConfigureModel}
          onHostedAccountConnect={onHostedAccountConnect}
          onHostedAccountCancel={onHostedAccountCancel}
          onHostedAccountBilling={onHostedAccountBilling}
          onDraftChange={onDraftChange}
          onAddLocalSource={onAddLocalSource}
          onAddDocumentContext={onAddDocumentContext}
          onImportFiles={onImportFiles}
          onOpenPath={onOpenArtifact}
          onRemoveDocumentContext={onRemoveDocumentContext}
          onRemoveLocalSource={onRemoveLocalSource}
          onKeyDown={handleKeyDown}
          onModelChange={onModelChange}
          onSend={sendComposer}
          onStop={onStop}
        />
      </div>
    </div>
  )
}
