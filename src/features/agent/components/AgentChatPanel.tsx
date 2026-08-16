import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo2,
  LoaderCircle,
  Presentation,
  Sparkles,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  AgentArtifact,
  AgentEvent,
  AgentLocalSource,
  AgentMessage,
  AgentSession,
  AgentSkillSpec,
  AgentTablePlanContext,
  AgentToolCall,
} from '@/api/agent'
import { KitionLogoMark } from '@/components/KitionLogoMark'
import { AgentAiComposer } from '@/features/agent/components/AgentAiComposer'
import {
  AgentContextCards,
} from '@/features/agent/components/AgentContextCards'
import {
  AgentPanelEmptyState,
} from '@/features/agent/components/AgentPanelChrome'
import { InteractiveAgentMarkdown } from '@/features/agent/components/InteractiveAgentMarkdown'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import type { KitionAccountStatus } from '@/features/account/hooks/useKitionAccount'
import { isKitionAccountUsable } from '@/features/account/lib/accountState'
import type { AgentMentionableDocument } from '@/features/agent/lib/documentMentions'
import {
  stripAgentDocumentMentions,
} from '@/features/agent/lib/documentMentions'
import {
  type AgentPaneContext,
  emptyStateForPane,
} from '@/features/agent/lib/paneEmptyState'
import { cn } from '@/lib/utils'
import { resolveAgentImageURL } from '@/services/workspaceFiles'
import {
  type AgentModelOption,
} from '@/features/agent/lib/agentConfig'
import { PlanCard, readLatestPlanSnapshot } from '@/features/agent/components/PlanCard'
import {
  AwaitUserInputModal,
  readLatestAwaitUserInputRequest,
} from '@/features/agent/components/AwaitUserInputModal'
import {
  buildAgentConversationTurns,
  buildAgentRunLogItems,
  extractAgentToolImageResults,
  formatAgentRunLogExpandedDetail,
  getAgentModifiedDocumentPaths,
  resolveAgentTimelineLocale,
  resolveAgentToolIcon,
  scopeAgentTurnArtifacts,
  scopeAgentTurnEventsById,
  scopeAgentTurnToolCallsById,
  type AgentRunLogItem,
  type AgentTimelineLocale,
  type AgentToolImageResult,
} from '@/features/agent/lib/agentTimeline'
import { getAgentTimelineDict } from '@/features/agent/lib/agentTimelineI18n'

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
  onSend: () => void
  onStop: () => void
  onConfigureModel: () => void
  onHostedAccountConnect?: () => void
  onHostedAccountCancel?: () => void
  onHostedAccountBilling?: () => void
  onModelChange: (value: string) => void
  onOpenArtifact: (path: string) => void
  onReviewModifiedArtifact?: (path: string) => void
  onApplyPlan?: (plan: AgentTablePlanContext) => void
  onImportFiles?: (files: File[]) => Promise<string[]>
  /** Active workbench pane the agent sits next to. Drives the
   *  empty-state copy so the suggestion prompts match what the user is
   *  actually looking at — "Summarize this document" makes no sense
   *  when the right pane is a workflow editor or table view. Defaults
   *  to 'document' to keep behaviour unchanged for legacy mounts. */
  paneContext?: AgentPaneContext
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
  formatTime,
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
  onImportFiles,
  paneContext = 'document',
  progressCard,
}: AgentChatPanelProps) {
  const hostedAccountBusy = hostedAccountStatus === 'loading' || hostedAccountStatus === 'connecting'
  const hostedAccountBlocked = Boolean(hostedAccountStatus && !isKitionAccountUsable(hostedAccountStatus))
  const hostedAccountCreditsEmpty = hostedAccountStatus === 'credits_empty'
  const canSend = draft.trim().length > 0 && !busy && !hostedAccountBusy && !hostedAccountCreditsEmpty
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
  }, [artifacts, busy, events, messages, streamingText, toolCalls])

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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSend) {
        onSend()
      }
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
          const emptyState = emptyStateForPane(paneContext, t)
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
            messages={messages}
            toolCalls={toolCalls}
            events={events}
            artifacts={artifacts}
            busy={busy}
            streamingText={streamingText}
            onOpenPath={onOpenArtifact}
            onOpenArtifact={onOpenArtifact}
            onAwaitUserInputSubmit={handleAwaitUserInputSubmit}
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
          busy={busy}
          canSend={canSend}
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
          onSend={() => onSend()}
          onStop={onStop}
        />
      </div>
    </div>
  )
}

function AgentChangedFilesCard({
  toolCalls,
  artifacts,
  onOpen,
}: {
  toolCalls: AgentToolCall[]
  artifacts: AgentArtifact[]
  onOpen: (path: string) => void
}) {
  const paths = Array.from(getAgentModifiedDocumentPaths(toolCalls))
  if (!paths.length) {
    return null
  }

  const resolveName = (path: string) =>
    artifacts.find((artifact) => artifact.path === path)?.title || path.split('/').pop() || path

  return (
    <details className="agent-changed-files">
      <summary className="agent-changed-files-head">
        <FileText className="size-3.5" />
        <span className="min-w-0 flex-1">{paths.length} file(s) modified</span>
        <ChevronRight className="agent-changed-files-chevron size-4 shrink-0" />
      </summary>
      <div className="agent-changed-files-list">
        {paths.map((path) => {
          const FileIcon = resolveAgentArtifactIcon(path)
          return (
            <button
              key={path}
              type="button"
              className="agent-changed-file"
              onClick={() => onOpen(path)}
              title={path}
              aria-label={`View changes in ${resolveName(path)}`}
            >
              <FileIcon className="size-4 shrink-0" />
              <span className="agent-changed-file-name">{resolveName(path)}</span>
              <span className="agent-changed-file-action">View</span>
            </button>
          )
        })}
      </div>
    </details>
  )
}

function AgentConversation({
  messages,
  toolCalls,
  events,
  artifacts,
  busy,
  streamingText,
  onOpenPath,
  onOpenArtifact,
  onAwaitUserInputSubmit,
}: {
  messages: AgentMessage[]
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  artifacts: AgentArtifact[]
  busy: boolean
  streamingText: string
  onOpenPath: (path: string) => void
  onOpenArtifact: (path: string) => void
  onAwaitUserInputSubmit?: (answer: string) => void
}) {
  const turns = buildAgentConversationTurns(messages)
  const shouldRenderStreaming = Boolean(streamingText)

  if (!turns.length) {
    const shouldRenderActivity = busy || toolCalls.length > 0 || events.length > 0 || artifacts.length > 0
    if (!shouldRenderActivity && !shouldRenderStreaming) {
      return null
    }
    return (
      <>
        {shouldRenderActivity ? (
          <AgentInlineActivity
            toolCalls={toolCalls}
            events={events}
            artifacts={artifacts}
            busy={busy}
            streamingText={streamingText}
            onOpenArtifact={onOpenArtifact}
            onAwaitUserInputSubmit={onAwaitUserInputSubmit}
          />
        ) : null}
        {shouldRenderStreaming ? <AgentStreamingMessageBubble content={streamingText} /> : null}
      </>
    )
  }

  const lastTurnIndex = turns.length - 1

  return (
    <>
      {turns.map((turn, turnIndex) => {
        const isActiveTurn = turnIndex === lastTurnIndex
        const userMessageId = turn.userMessage?.id ?? 0
        const turnToolCalls = scopeAgentTurnToolCallsById(toolCalls, userMessageId, isActiveTurn)
        const turnEvents = scopeAgentTurnEventsById(events, userMessageId, isActiveTurn)
        const nextTurnStart = turns[turnIndex + 1]?.userMessage?.created_at ?? null
        const turnArtifacts = scopeAgentTurnArtifacts(
          artifacts,
          turn.userMessage?.created_at ?? null,
          isActiveTurn ? null : nextTurnStart,
        )
        const turnBusy = isActiveTurn && busy
        const turnStreaming = isActiveTurn ? streamingText : ''
        const shouldRenderActivity =
          turnBusy || turnToolCalls.length > 0 || turnEvents.length > 0 || turnArtifacts.length > 0

        return (
          <Fragment key={turn.key}>
            {turn.userMessage ? (
              <AgentMessageBubble message={turn.userMessage} onOpenPath={onOpenPath} />
            ) : null}
            {shouldRenderActivity ? (
              <AgentInlineActivity
                toolCalls={turnToolCalls}
                events={turnEvents}
                artifacts={turnArtifacts}
                busy={turnBusy}
                streamingText={turnStreaming}
                onOpenArtifact={onOpenArtifact}
                onAwaitUserInputSubmit={isActiveTurn ? onAwaitUserInputSubmit : undefined}
              />
            ) : null}
            {turn.replies.map((reply) => (
              <AgentMessageBubble key={reply.id} message={reply} onOpenPath={onOpenPath} />
            ))}
            {isActiveTurn && shouldRenderStreaming ? (
              <AgentStreamingMessageBubble content={streamingText} />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}

function AgentInlineActivity({
  toolCalls,
  events,
  artifacts,
  busy,
  streamingText,
  onOpenArtifact,
  onAwaitUserInputSubmit,
}: {
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  artifacts: AgentArtifact[]
  busy: boolean
  streamingText: string
  onOpenArtifact: (path: string) => void
  onAwaitUserInputSubmit?: (answer: string) => void
}) {
  const { settings } = useDesktopSettings()
  const locale = resolveAgentTimelineLocale(settings.general.language)
  const localeDict = getAgentTimelineDict(locale)
  const runLogItems = buildAgentRunLogItems({
    events,
    toolCalls,
    artifacts,
    busy,
    streamingText,
    debug: settings.general.debug,
    locale,
  })
  const planSnapshot = readLatestPlanSnapshot(events)
  const awaitRequest = readLatestAwaitUserInputRequest(toolCalls)
  const modifiedPaths = getAgentModifiedDocumentPaths(toolCalls)
  const imageTools = toolCalls
    .map((toolCall) => ({ id: toolCall.id, images: extractAgentToolImageResults(toolCall.output_data) }))
    .filter((entry) => entry.images.length > 0)

  return (
    <div className="agent-inline-activity">
      {busy && !runLogItems.length ? (
        <div className="agent-exec-thinking">
          <Sparkles className="size-3.5" />
          <span>{localeDict.activity.thinking}</span>
        </div>
      ) : null}
      {planSnapshot ? <PlanCard snapshot={planSnapshot} /> : null}
      {awaitRequest ? (
        <AwaitUserInputModal
          request={awaitRequest}
          onSubmit={onAwaitUserInputSubmit}
          busy={busy}
        />
      ) : null}
      <AgentRunLog items={runLogItems} locale={locale} dict={localeDict} />
      {imageTools.map((entry) => (
        <AgentToolImageStrip key={`images-${entry.id}`} images={entry.images} />
      ))}
      {artifacts.length ? (
        <div className="agent-artifacts is-inline">
          {artifacts.map((artifact) => {
            const ArtifactIcon = resolveAgentArtifactIcon(artifact.path)
            const isModified = modifiedPaths.has(artifact.path)
            return (
              <button
                key={artifact.id}
                type="button"
                className={cn('agent-artifact', isModified && 'is-modified')}
                onClick={() => onOpenArtifact(artifact.path)}
                title={isModified ? `@ modified ${artifact.path}` : artifact.path}
              >
                {isModified ? <span className="agent-artifact-at">@</span> : null}
                <ArtifactIcon className="size-4" />
                <span>{artifact.path}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function AgentMessageBubble({
  message,
  onOpenPath,
}: {
  message: AgentMessage
  onOpenPath: (path: string) => void
}) {
  const isUser = message.role === 'user'
  return (
    <div
      className={cn('agent-message', isUser ? 'is-user' : 'is-assistant')}
      data-role={isUser ? 'user' : 'assistant'}
    >
      {isUser ? (
        <div className="agent-message-content whitespace-pre-wrap">
          {renderAgentUserMessageContent(message.content)}
        </div>
      ) : (
        <InteractiveAgentMarkdown
          className="agent-message-content"
          content={message.content}
          onOpenPath={onOpenPath}
        />
      )}
    </div>
  )
}

function AgentStreamingMessageBubble({ content }: { content: string }) {
  return (
    <div className="agent-message is-assistant is-streaming" data-role="assistant">
      <InteractiveAgentMarkdown
        className="agent-message-content"
        content={content}
      />
    </div>
  )
}

function renderAgentUserMessageContent(
  content: string,
) {
  const visibleContent = stripAgentDocumentMentions(content)
  return visibleContent ? <span>{visibleContent}</span> : null
}

function AgentRunLog({
  items,
  locale,
  dict,
}: {
  items: AgentRunLogItem[]
  locale: AgentTimelineLocale
  dict: ReturnType<typeof getAgentTimelineDict>
}) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

  if (!items.length) {
    return null
  }

  function toggleItem(key: string) {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <div className="agent-run-log" aria-live="polite">
      {items.map((item, index) => {
        const expanded = expandedKeys.has(item.key)
        const expandedDetail = formatAgentRunLogExpandedDetail(item, locale)
        const nextCreatedAt = items[index + 1]?.createdAt
        return (
          <div key={item.key} className={cn('agent-run-log-item', `is-${item.status}`, expanded && 'is-expanded')}>
            <button
              type="button"
              className="agent-run-log-row"
              onClick={() => toggleItem(item.key)}
              aria-expanded={expanded}
            >
              <span className="agent-run-log-icon">
                {renderAgentRunLogIcon(item)}
              </span>
              <span className="agent-run-log-copy">
                <strong>{item.title}</strong>
                {item.detail ? <span className="agent-run-log-detail-inline">{item.detail}</span> : null}
              </span>
              <span className="agent-run-log-duration">
                <AgentRunLogDuration item={item} nextCreatedAt={nextCreatedAt} />
              </span>
              <span className="agent-run-log-chevron">
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </span>
            </button>
            {expanded ? (
              <div className="agent-run-log-detail">
                {expandedDetail ? <pre>{expandedDetail}</pre> : <p>{dict.sections.noDetail}</p>}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function AgentRunLogDuration({
  item,
  nextCreatedAt,
}: {
  item: AgentRunLogItem
  nextCreatedAt?: string
}) {
  if (item.status === 'running') {
    return <AgentRunLogLiveDuration startISO={item.createdAt} />
  }
  if (item.status === 'completed' || item.status === 'failed') {
    if (!nextCreatedAt) return null
    const start = Date.parse(item.createdAt)
    const end = Date.parse(nextCreatedAt)
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
    return <>{formatAgentRunLogDuration(end - start)}</>
  }
  return null
}

function AgentRunLogLiveDuration({ startISO }: { startISO: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const start = Date.parse(startISO)
  if (Number.isNaN(start)) return null
  const elapsedMs = Math.max(0, now - start)
  if (elapsedMs < 60_000) {
    return <>{`${Math.floor(elapsedMs / 1000)}s`}</>
  }
  return <>{formatAgentRunLogDuration(elapsedMs)}</>
}

function formatAgentRunLogDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

function renderAgentRunLogIcon(item: AgentRunLogItem) {
  if (item.status === 'running') {
    return <LoaderCircle className="size-3.5 animate-spin" />
  }
  if (item.status === 'failed') {
    return <X className="size-3.5" />
  }
  if (item.status === 'pending') {
    return <Clock3 className="size-3.5" />
  }
  if (item.kind === 'tool' && item.toolName) {
    const outputPath = typeof item.payload?.output?.path === 'string' ? item.payload.output.path : undefined
    const ToolIcon = resolveAgentToolIcon(item.toolName, outputPath)
    return <ToolIcon className="size-3.5" />
  }
  if (item.kind === 'artifact') {
    return <FileText className="size-3.5" />
  }
  if (item.kind === 'final') {
    return <Sparkles className="size-3.5" />
  }
  return <Check className="size-3.5" />
}

function AgentToolImageStrip({ images }: { images: AgentToolImageResult[] }) {
  return (
    <div className="agent-tool-image-strip">
      {images.slice(0, 6).map((image, index) => {
        const previewURL = resolveAgentImageURL(image.preview_url || image.thumb_url || image.url)
        const href = resolveAgentImageURL(image.page_url || image.url)
        return (
          <a
            key={`${image.url}-${index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="agent-tool-image-thumb"
            title={image.title || image.alt || image.source || image.url}
          >
            <img src={previewURL} alt={image.alt || image.title || 'Image result'} loading="lazy" />
            {image.source ? <span>{image.source}</span> : null}
          </a>
        )
      })}
    </div>
  )
}

function resolveAgentArtifactIcon(path: string): LucideIcon {
  const lowerPath = path.toLowerCase()
  if (/\.(xlsx|xls|csv|tsv|kitable)$/i.test(lowerPath)) {
    return FileSpreadsheet
  }
  if (/\.docx$/i.test(lowerPath)) {
    return FileType2
  }
  if (/\.(pptx|ppt)$/i.test(lowerPath)) {
    return Presentation
  }
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lowerPath)) {
    return FileImage
  }
  if (/\.(mp4|mov|webm)$/i.test(lowerPath)) {
    return FileVideo2
  }
  if (/\.(mp3|wav|m4a)$/i.test(lowerPath)) {
    return Volume2
  }
  return FileText
}
