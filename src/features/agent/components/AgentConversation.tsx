import { useTranslation } from 'react-i18next'
import { getGeneratedImageToolOutputPaths, isGeneratedImageArtifact } from '@/features/media-generation/public'
import {
  Check, ChevronDown, ChevronRight, Clock3, FileImage, FileSpreadsheet,
  FileText, FileType2, FileVideo2, LoaderCircle, Presentation, Sparkles, Volume2, X,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import type { AgentShellApprovalDecision, AgentShellApprovalRequest } from '@/api/agent'
import { InteractiveAgentMarkdown } from './InteractiveAgentMarkdown'
import { PlanCard } from './PlanCard'
import { AgentShellApprovalCard } from './AgentShellApprovalCard'
import { AgentImageResultCards, type AgentImageResultActions } from './AgentImageResultCards'
import { imageJobOf } from '../lib/agentImageJob'
import { agentModifiedDocumentPaths } from '../lib/agentEventEffects'
import {
  pendingApprovalOf,
  type AgentLiveAttempt,
  type AgentSessionView,
  type AgentTurnView,
} from '../lib/agentSessionView'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import { stripAgentDocumentMentions } from '../lib/documentMentions'
import { cn } from '@/lib/utils'
import { resolveAgentImageURL, resolveAgentImageWorkspacePath } from '@/services/workspaceFiles'
import {
  buildAgentRunLogItems, extractAgentToolImageResults,
  formatAgentRunLogExpandedDetail, resolveAgentTimelineLocale,
  resolveAgentToolIcon,
  type AgentRunLogItem, type AgentTimelineLocale, type AgentToolImageResult,
} from '../lib/agentTimeline'
import { getAgentTimelineDict } from '../lib/agentTimelineI18n'

/** The files the session's turns changed, with the name each delivery gave them. */
export function AgentChangedFilesCard({
  view,
  onOpen,
}: {
  view: AgentSessionView
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation('agent')
  const paths = Array.from(agentModifiedDocumentPaths(view.turns.flatMap((turn) => turn.toolRuns)))
  if (!paths.length) {
    return null
  }

  const deliverables = view.turns.flatMap((turn) => turn.deliverables)
  const resolveName = (path: string) =>
    deliverables.find((file) => file.path === path)?.description || path.split('/').pop() || path

  return (
    <details className="agent-changed-files">
      <summary className="agent-changed-files-head">
        <FileText className="size-3.5" />
        <span className="min-w-0 flex-1">{t('results.modifiedFiles', { count: paths.length })}</span>
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
              aria-label={t('results.viewChanges', { name: resolveName(path) })}
            >
              <FileIcon className="size-4 shrink-0" />
              <span className="agent-changed-file-name">{resolveName(path)}</span>
              <span className="agent-changed-file-action">{t('results.view')}</span>
            </button>
          )
        })}
      </div>
    </details>
  )
}

/** The paused command of the session, for the approval card. */
function approvalRequestOf(view: AgentSessionView): AgentShellApprovalRequest | null {
  const approval = pendingApprovalOf(view)
  return approval?.request ? { ...approval.request, call_id: approval.callId } : null
}

export function AgentConversation({
  view,
  pendingUserText = '',
  imageActions,
  busy,
  onOpenPath,
  onOpenArtifact,
  onShellApprovalDecision,
}: {
  view: AgentSessionView
  /** The visible message just sent, until its turn is logged. */
  pendingUserText?: string
  imageActions?: AgentImageResultActions
  busy: boolean
  onOpenPath: (path: string) => void
  onOpenArtifact: (path: string) => void
  onShellApprovalDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
}) {
  const { i18n } = useTranslation('agent')
  const shellApprovalRequest = approvalRequestOf(view)
  const lastTurn = view.turns.at(-1)
  // A send whose turn has not started yet still shows that the agent is working.
  const waiting = busy && (!lastTurn || Boolean(lastTurn.end) || Boolean(pendingUserText))

  return (
    <>
      {view.turns.map((turn, turnIndex) => {
        const isActiveTurn = turnIndex === view.turns.length - 1
        const turnBusy = isActiveTurn && busy && !turn.end && !pendingUserText
        const live = isActiveTurn && view.live?.turn === turn.turn ? view.live : null
        const job = imageJobOf(turn)
        return (
          <Fragment key={`turn-${turn.turn}`}>
            {turn.source === 'user' && turn.userText ? (
              <AgentMessageBubble role="user" content={turn.userText} onOpenPath={onOpenPath} />
            ) : null}
            <AgentInlineActivity
              turn={turn}
              live={live}
              hiddenImagePaths={job?.artifacts.map((artifact) => artifact.path) ?? []}
              busy={turnBusy}
              onOpenArtifact={onOpenArtifact}
              shellApprovalRequest={isActiveTurn ? shellApprovalRequest : null}
              onShellApprovalDecision={isActiveTurn ? onShellApprovalDecision : undefined}
            />
            {job ? <AgentImageResultCards job={job} busy={busy} onOpen={onOpenArtifact} {...imageActions} /> : null}
            {turn.reply ? <AgentMessageBubble role="assistant" content={turn.reply} onOpenPath={onOpenPath} /> : null}
            {!turn.reply && turn.partialReply && !live?.text ? (
              <AgentMessageBubble role="assistant" content={turn.partialReply} onOpenPath={onOpenPath} />
            ) : null}
            {live?.text ? <AgentStreamingMessageBubble content={live.text} /> : null}
          </Fragment>
        )
      })}
      {pendingUserText ? <AgentMessageBubble role="user" content={pendingUserText} onOpenPath={onOpenPath} /> : null}
      {waiting ? <AgentThinking locale={resolveAgentTimelineLocale(i18n.resolvedLanguage)} /> : null}
    </>
  )
}

function AgentThinking({ locale }: { locale: AgentTimelineLocale }) {
  return (
    <div className="agent-inline-activity">
      <div className="agent-exec-thinking">
        <Sparkles className="size-3.5" />
        <span>{getAgentTimelineDict(locale).activity.thinking}</span>
      </div>
    </div>
  )
}

function AgentInlineActivity({
  turn,
  live,
  hiddenImagePaths,
  busy,
  onOpenArtifact,
  shellApprovalRequest,
  onShellApprovalDecision,
}: {
  turn: AgentTurnView
  live: AgentLiveAttempt | null
  hiddenImagePaths: string[]
  busy: boolean
  onOpenArtifact: (path: string) => void
  shellApprovalRequest?: AgentShellApprovalRequest | null
  onShellApprovalDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
}) {
  const { settings } = useDesktopSettings()
  const { t, i18n } = useTranslation('agent')
  const locale = resolveAgentTimelineLocale(i18n.resolvedLanguage || settings.general.language)
  const localeDict = getAgentTimelineDict(locale)
  const runLogItems = buildAgentRunLogItems({
    turn,
    live,
    busy,
    debug: settings.general.debug,
    locale,
  })
  const modifiedPaths = agentModifiedDocumentPaths(turn.toolRuns)
  const shownImages = new Set(hiddenImagePaths)
  const imageTools = turn.toolRuns
    .map((run) => ({ id: run.callId, images: [
      ...extractAgentToolImageResults(run.output),
      ...getGeneratedImageToolOutputPaths({ tool_name: run.name, status: run.status, output_data: run.output })
        .map((url) => ({ url })),
    ].filter((image) => {
      if (shownImages.has(image.url)) return false
      shownImages.add(image.url)
      return true
    }) }))
    .filter((entry) => entry.images.length > 0)
  const deliverables = turn.deliverables.filter((file) => !hiddenImagePaths.includes(file.path))
  const deliveredImages = deliverables
    .filter((file) => isGeneratedImageArtifact({ path: file.path }) && !shownImages.has(file.path))
    .map((file) => ({ url: file.path, title: file.description }))

  if (!busy && !runLogItems.length && !turn.todos && !shellApprovalRequest && !imageTools.length && !deliverables.length) {
    return null
  }

  return (
    <div className="agent-inline-activity">
      {busy && !runLogItems.length ? (
        <div className="agent-exec-thinking">
          <Sparkles className="size-3.5" />
          <span>{localeDict.activity.thinking}</span>
        </div>
      ) : null}
      {turn.todos ? (
        <PlanCard snapshot={{
          explanation: turn.todos.explanation,
          plan: turn.todos.items.map((item) => ({ step: item.content, status: item.status })),
        }} />
      ) : null}
      {shellApprovalRequest ? (
        <AgentShellApprovalCard
          request={shellApprovalRequest}
          busy={busy}
          onDecision={onShellApprovalDecision}
        />
      ) : null}
      <AgentRunLog items={runLogItems} locale={locale} dict={localeDict} />
      <AgentToolImageStrip images={deliveredImages} onOpenArtifact={onOpenArtifact} />
      {imageTools.map((entry) => (
        <AgentToolImageStrip key={`images-${entry.id}`} images={entry.images} onOpenArtifact={onOpenArtifact} />
      ))}
      {deliverables.length ? (
        <div className="agent-artifacts is-inline">
          {deliverables.map((file) => {
            const ArtifactIcon = resolveAgentArtifactIcon(file.path)
            const isModified = modifiedPaths.has(file.path)
            return (
              <button
                key={`${file.callId}-${file.path}`}
                type="button"
                className={cn('agent-artifact', isModified && 'is-modified')}
                onClick={() => onOpenArtifact(file.path)}
                title={isModified ? t('results.modifiedArtifact', { path: file.path }) : file.path}
              >
                {isModified ? <span className="agent-artifact-at">@</span> : null}
                <ArtifactIcon className="size-4" />
                <span>{file.path}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function AgentMessageBubble({
  role,
  content,
  onOpenPath,
}: {
  role: 'user' | 'assistant'
  content: string
  onOpenPath: (path: string) => void
}) {
  const isUser = role === 'user'
  return (
    <div
      className={cn('agent-message', isUser ? 'is-user' : 'is-assistant')}
      data-role={isUser ? 'user' : 'assistant'}
    >
      {isUser ? (
        <div className="agent-message-content whitespace-pre-wrap">
          {renderAgentUserMessageContent(content)}
        </div>
      ) : (
        <InteractiveAgentMarkdown
          className="agent-message-content"
          content={content}
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

function AgentToolImageStrip({ images, onOpenArtifact }: {
  images: AgentToolImageResult[]
  onOpenArtifact: (path: string) => void
}) {
  const { t } = useTranslation('agent')
  if (!images.length) return null
  return (
    <div className="agent-tool-image-strip">
      {images.slice(0, 6).map((image, index) => {
        const previewURL = resolveAgentImageURL(image.preview_url || image.thumb_url || image.url)
        const workspacePath = resolveAgentImageWorkspacePath(image.url)
        const href = resolveAgentImageURL(image.page_url || image.url)
        const title = image.title || image.alt || image.source || image.url
        const content = <>
          <img src={previewURL} alt={image.alt || image.title || t('results.imageResult')} loading="lazy" />
          {image.source ? <span>{image.source}</span> : null}
        </>
        return workspacePath ? (
          <button
            key={`${image.url}-${index}`}
            type="button"
            className="agent-tool-image-thumb p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={title}
            onClick={() => onOpenArtifact(workspacePath)}
          >
            {content}
          </button>
        ) : (
          <a
            key={`${image.url}-${index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="agent-tool-image-thumb"
            title={title}
          >
            {content}
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
