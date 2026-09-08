import { getGeneratedImageToolOutputPaths, isGeneratedImageArtifact } from '@/features/media-generation/lib/generatedImageArtifacts'
import {
  Check, ChevronDown, ChevronRight, Clock3, FileImage, FileSpreadsheet,
  FileText, FileType2, FileVideo2, LoaderCircle, Presentation, Sparkles, Volume2, X,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import type { AgentArtifact, AgentEvent, AgentMessage, AgentToolCall, AgentShellApprovalDecision, AgentShellApprovalRequest } from '@/api/agent'
import { InteractiveAgentMarkdown } from './InteractiveAgentMarkdown'
import { PlanCard, readLatestPlanSnapshot } from './PlanCard'
import { AwaitUserInputModal, readLatestAwaitUserInputRequest } from './AwaitUserInputModal'
import { AgentShellApprovalCard } from './AgentShellApprovalCard'
import { AgentImageResultCards, type AgentImageResultActions } from './AgentImageResultCards'
import { imageEventsForTurn, type AgentImageSessionEvent } from '../lib/agentImageJobs'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import { stripAgentDocumentMentions } from '../lib/documentMentions'
import { cn } from '@/lib/utils'
import { resolveAgentImageURL } from '@/services/workspaceFiles'
import {
  buildAgentConversationTurns, buildAgentRunLogItems, extractAgentToolImageResults,
  formatAgentRunLogExpandedDetail, getAgentModifiedDocumentPaths, resolveAgentTimelineLocale,
  resolveAgentToolIcon, scopeAgentTurnArtifacts, scopeAgentTurnEventsById, scopeAgentTurnToolCallsById,
  type AgentRunLogItem, type AgentTimelineLocale, type AgentToolImageResult,
} from '../lib/agentTimeline'
import { getAgentTimelineDict } from '../lib/agentTimelineI18n'
import { readLatestAgentShellApprovalRequest } from '../lib/agentShellApproval'

export function AgentChangedFilesCard({
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

export function AgentConversation({
  messages,
  imageEvents = [],
  imageActions,
  toolCalls,
  events,
  artifacts,
  busy,
  streamingText,
  onOpenPath,
  onOpenArtifact,
  onAwaitUserInputSubmit,
  onShellApprovalDecision,
}: {
  messages: AgentMessage[]
  imageEvents?: AgentImageSessionEvent[]
  imageActions?: AgentImageResultActions
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  artifacts: AgentArtifact[]
  busy: boolean
  streamingText: string
  onOpenPath: (path: string) => void
  onOpenArtifact: (path: string) => void
  onAwaitUserInputSubmit?: (answer: string) => void
  onShellApprovalDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
}) {
  const typedImagePaths = new Set(imageEvents.flatMap((event) => event.artifact ? [event.artifact.path] : []))
  const turns = buildAgentConversationTurns(messages)
  const shouldRenderStreaming = Boolean(streamingText)
  const shellApprovalRequest = readLatestAgentShellApprovalRequest(toolCalls, messages)

  if (!turns.length) {
    const shouldRenderActivity = busy || toolCalls.length > 0 || events.length > 0 || artifacts.length > 0
    if (!shouldRenderActivity && !shouldRenderStreaming) {
      return null
    }
    return (
      <>
        {shouldRenderActivity ? (
          <AgentInlineActivity
            hiddenImagePaths={imageEvents.flatMap((event) => event.artifact ? [event.artifact.path] : [])}
            toolCalls={toolCalls}
            events={events}
            artifacts={artifacts.filter((artifact) => !typedImagePaths.has(artifact.path))}
            busy={busy}
            streamingText={streamingText}
            onOpenArtifact={onOpenArtifact}
            onAwaitUserInputSubmit={onAwaitUserInputSubmit}
            shellApprovalRequest={shellApprovalRequest}
            onShellApprovalDecision={onShellApprovalDecision}
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
                hiddenImagePaths={imageEvents.flatMap((event) => event.artifact ? [event.artifact.path] : [])}
                toolCalls={turnToolCalls}
                events={turnEvents}
                artifacts={turnArtifacts.filter((artifact) => !typedImagePaths.has(artifact.path))}
                busy={turnBusy}
                streamingText={turnStreaming}
                onOpenArtifact={onOpenArtifact}
                onAwaitUserInputSubmit={isActiveTurn ? onAwaitUserInputSubmit : undefined}
                shellApprovalRequest={isActiveTurn ? shellApprovalRequest : null}
                onShellApprovalDecision={isActiveTurn ? onShellApprovalDecision : undefined}
              />
            ) : null}
            <AgentImageResultCards
              events={imageEventsForTurn(imageEvents, turn.userMessage || undefined, nextTurnStart, isActiveTurn)}
              busy={busy} onOpen={onOpenArtifact} {...imageActions}
            />
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
  hiddenImagePaths = [],
  toolCalls,
  events,
  artifacts,
  busy,
  streamingText,
  onOpenArtifact,
  onAwaitUserInputSubmit,
  shellApprovalRequest,
  onShellApprovalDecision,
}: {
  hiddenImagePaths?: string[]
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  artifacts: AgentArtifact[]
  busy: boolean
  streamingText: string
  onOpenArtifact: (path: string) => void
  onAwaitUserInputSubmit?: (answer: string) => void
  shellApprovalRequest?: AgentShellApprovalRequest | null
  onShellApprovalDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
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
  const shownImages = new Set(hiddenImagePaths)
  const imageTools = toolCalls
    .map((toolCall) => ({ id: toolCall.id, images: [
      ...extractAgentToolImageResults(toolCall.output_data),
      ...getGeneratedImageToolOutputPaths(toolCall).map((url) => ({ url })),
    ].filter((image) => {
      if (shownImages.has(image.url)) return false
      shownImages.add(image.url)
      return true
    }) }))
    .filter((entry) => entry.images.length > 0)

  const artifactImages = artifacts.filter((artifact) => isGeneratedImageArtifact(artifact) && !shownImages.has(artifact.path))
    .map((artifact) => ({ url: artifact.path, title: artifact.title }))

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
      {shellApprovalRequest ? (
        <AgentShellApprovalCard
          request={shellApprovalRequest}
          busy={busy}
          onDecision={onShellApprovalDecision}
        />
      ) : null}
      <AgentRunLog items={runLogItems} locale={locale} dict={localeDict} />
      <AgentToolImageStrip images={artifactImages} />
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
  if (!images.length) return null
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
