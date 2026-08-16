import { ArrowUp, Check, FileText, Folder, X } from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Textarea } from '@/components/ui'
import type { AgentLocalSource } from '@/api/agent'
import { AgentContextAddMenu } from '@/features/agent/components/AgentContextAddMenu'
import { AgentContextTray } from '@/features/agent/components/AgentContextTray'
import { AgentModelPicker } from '@/features/agent/components/AgentModelPicker'
import type { KitionAccountStatus } from '@/features/account/hooks/useKitionAccount'
import type { AgentModelOption } from '@/features/agent/lib/agentConfig'
import {
  findAgentMentionQuery,
  searchAgentMentionableDocuments,
  stripAgentDocumentMentions,
  type AgentMentionableDocument,
} from '@/features/agent/lib/documentMentions'
import { cn } from '@/lib/utils'

type AgentAiComposerProps = {
  busy: boolean
  canSend: boolean
  compact?: boolean
  currentDocumentPath?: string
  documentContextPaths?: string[]
  draft: string
  localSources?: AgentLocalSource[]
  mentionableDocuments: AgentMentionableDocument[]
  modelOptions: AgentModelOption[]
  needsModelConfig: boolean
  hostedAccountStatus?: KitionAccountStatus
  selectedModelKey: string
  onConfigureModel: () => void
  onHostedAccountConnect?: () => void
  onHostedAccountCancel?: () => void
  onHostedAccountBilling?: () => void
  onDraftChange: (value: string) => void
  onAddLocalSource?: () => void
  onImportFiles?: (files: File[]) => Promise<string[]>
  onOpenPath?: (path: string) => void
  onAddDocumentContext?: (path: string) => void
  onRemoveDocumentContext?: (path: string) => void
  onRemoveLocalSource?: (sourceId: string) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  onModelChange: (value: string) => void
  onSend: () => void
  onStop: () => void
}

export function AgentAiComposer({
  busy,
  canSend,
  compact = false,
  currentDocumentPath = '',
  documentContextPaths = [],
  draft,
  localSources = [],
  mentionableDocuments,
  modelOptions,
  needsModelConfig,
  hostedAccountStatus,
  selectedModelKey,
  onConfigureModel,
  onHostedAccountConnect,
  onHostedAccountCancel,
  onHostedAccountBilling,
  onDraftChange,
  onAddLocalSource,
  onImportFiles,
  onOpenPath,
  onAddDocumentContext,
  onRemoveDocumentContext,
  onRemoveLocalSource,
  onKeyDown,
  onModelChange,
  onSend,
  onStop,
}: AgentAiComposerProps) {
  const { t } = useTranslation('agent')
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0)
  const [mentionMenuDismissed, setMentionMenuDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)
  const visibleDraft = stripAgentDocumentMentions(draft)
  const documentsByPath = new Map(
    mentionableDocuments.map((document) => [document.path, document]),
  )
  const contextDocuments = documentContextPaths.map((path) => ({
    path,
    kind: documentsByPath.get(path)?.kind,
    current: path === currentDocumentPath,
  }))
  const currentDocument = documentsByPath.get(currentDocumentPath)
  useEffect(() => {
    function handle() {
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const end = el.value.length
        el.setSelectionRange(end, end)
      })
    }
    window.addEventListener('kition:agent:focus-composer', handle)
    return () => {
      window.removeEventListener('kition:agent:focus-composer', handle)
    }
  }, [])

  const mentionQuery = findAgentMentionQuery(
    visibleDraft,
    textareaRef.current?.selectionStart ?? visibleDraft.length,
  )
  const matchingMentions = useMemo(
    () => mentionQuery
      ? searchAgentMentionableDocuments({
          documents: mentionableDocuments,
          query: mentionQuery.query,
          currentDocumentPath,
          contextPaths: documentContextPaths,
        })
      : [],
    [currentDocumentPath, documentContextPaths, mentionQuery?.query, mentionableDocuments],
  )
  const visibleMentions = matchingMentions.slice(
    0,
    mentionQuery?.query.trim() ? 50 : 16,
  )
  const selectableMentions = visibleMentions.filter(
    (document) => !documentContextPaths.includes(document.path),
  )
  const highlightedMention = selectableMentions[highlightedMentionIndex]
  const mentionMenuOpen = Boolean(mentionQuery && !mentionMenuDismissed)

  useEffect(() => {
    setHighlightedMentionIndex(0)
    setMentionMenuDismissed(false)
  }, [mentionQuery?.query])

  useEffect(() => {
    if (!highlightedMention) return
    const highlightedElement = Array.from(
      mentionMenuRef.current?.querySelectorAll<HTMLElement>('[data-mention-path]') || [],
    ).find((element) => element.dataset.mentionPath === highlightedMention.path)
    highlightedElement?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedMention])

  function updateVisibleDraft(nextVisibleDraft: string) {
    onDraftChange(nextVisibleDraft)
  }

  function selectMention(document: AgentMentionableDocument) {
    if (!mentionQuery) {
      return
    }
    if (documentContextPaths.includes(document.path)) {
      return
    }
    const head = visibleDraft.slice(0, mentionQuery.start)
    const rawTail = visibleDraft.slice(mentionQuery.end)
    const tail = /\s$/.test(head) && /^\s/.test(rawTail)
      ? rawTail.replace(/^\s+/, '')
      : rawTail
    const nextVisibleDraft = `${head}${tail}`
    onDraftChange(nextVisibleDraft)
    onAddDocumentContext?.(document.path)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(head.length, head.length)
    })
  }

  async function handleImportedFiles(files: File[]) {
    if (!onImportFiles || !files.length) {
      return
    }
    const importedPaths = await onImportFiles(files)
    if (!importedPaths.length) {
      return
    }
    onDraftChange(visibleDraft)
    importedPaths.forEach((path) => onAddDocumentContext?.(path))
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  function requestDocumentReference() {
    const spacer = visibleDraft && !/\s$/.test(visibleDraft) ? ' ' : ''
    const nextVisibleDraft = `${visibleDraft}${spacer}@`
    updateVisibleDraft(nextVisibleDraft)
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) {
        return
      }
      textarea.focus()
      textarea.setSelectionRange(nextVisibleDraft.length, nextVisibleDraft.length)
    })
  }

  return (
    <div className={cn('agent-ai-composer', compact && 'is-compact')}>
      <AgentContextTray
        documents={contextDocuments}
        sources={localSources}
        disabled={busy}
        onOpenPath={onOpenPath}
        onRemoveDocument={(path) => onRemoveDocumentContext?.(path)}
        onRemoveSource={onRemoveLocalSource}
      />
      <Textarea
        ref={textareaRef}
        value={visibleDraft}
        onChange={(event) => updateVisibleDraft(event.target.value)}
        onDragOver={onImportFiles ? (event) => {
          if (event.dataTransfer?.types?.includes('Files')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        } : undefined}
        onDrop={onImportFiles ? (event) => {
          const files = Array.from(event.dataTransfer?.files || [])
          if (!files.length) {
            return
          }
          event.preventDefault()
          void handleImportedFiles(files)
        } : undefined}
        onPaste={onImportFiles ? (event) => {
          const files = Array.from(event.clipboardData?.files || [])
          if (!files.length) {
            return
          }
          event.preventDefault()
          void handleImportedFiles(files)
        } : undefined}
        onKeyDown={(event) => {
          if (mentionMenuOpen) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlightedMentionIndex((current) =>
                Math.min(Math.max(0, selectableMentions.length - 1), current + 1),
              )
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlightedMentionIndex((current) => Math.max(0, current - 1))
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              const selectedMention = highlightedMention || selectableMentions[0]
              if (selectedMention) {
                event.preventDefault()
                selectMention(selectedMention)
                return
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMentionMenuDismissed(true)
              return
            }
          }
          onKeyDown(event)
        }}
        placeholder="Plan, write, or ask anything…"
        disabled={busy}
      />
      {mentionMenuOpen ? (
        <div
          className="agent-mention-menu max-h-[22rem] overflow-y-auto"
          ref={mentionMenuRef}
          role="listbox"
          style={{
            overscrollBehavior: 'contain',
            scrollbarColor: 'hsl(var(--muted-foreground) / 0.28) transparent',
            scrollbarWidth: 'thin',
          }}
        >
          <div className="agent-mention-menu__header sticky top-0 z-[1] border-b bg-card/95 px-4 py-2 text-[11px] text-muted-foreground backdrop-blur">
            {mentionQuery?.query.trim()
              ? t('mentions.resultCount', { count: matchingMentions.length })
              : t('mentions.searchHint')}
          </div>
          {visibleMentions.length ? visibleMentions.map((document) => {
            const attached = documentContextPaths.includes(document.path)
            const current = document.path === currentDocumentPath
            const active = highlightedMention?.path === document.path
            const content = (
              <>
                {document.kind === 'folder' ? (
                  <Folder className="agent-mention-menu__icon size-4 shrink-0" />
                ) : (
                  <FileText className="agent-mention-menu__icon size-4 shrink-0" />
                )}
                <span className="agent-mention-menu__text">
                  <strong>{document.title}</strong>
                  <span>{document.path}</span>
                </span>
                {current ? (
                  <small className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
                    {t('analysisWorkspace.current')}
                  </small>
                ) : null}
                {attached ? (
                  <span className="agent-mention-menu__attached inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <Check className="size-3" aria-hidden="true" />
                    {t('mentions.attached')}
                  </span>
                ) : null}
              </>
            )
            return attached ? (
              <div
                key={document.path}
                className="agent-mention-menu__item is-attached cursor-default bg-muted/25"
                data-mention-path={document.path}
                role="option"
                aria-disabled="true"
              >
                {content}
              </div>
            ) : (
              <button
                key={document.path}
                type="button"
                className={cn('agent-mention-menu__item', active && 'is-active')}
                data-mention-path={document.path}
                role="option"
                aria-selected={active}
                onMouseDown={(event) => {
                  event.preventDefault()
                  selectMention(document)
                }}
              >
                {content}
              </button>
            )
          }) : (
            <div className="agent-mention-menu__empty px-4 py-6 text-center text-xs text-muted-foreground">
              {t('mentions.noMatches')}
            </div>
          )}
        </div>
      ) : null}
      <div className="agent-ai-footer">
        <AgentContextAddMenu
          disabled={busy}
          currentDocumentTitle={currentDocument?.title}
          currentDocumentAttached={Boolean(
            currentDocumentPath && documentContextPaths.includes(currentDocumentPath),
          )}
          localSourceCount={localSources.length}
          onAddCurrentDocument={currentDocument && onAddDocumentContext
            ? () => onAddDocumentContext(currentDocument.path)
            : undefined}
          onAddLocalSource={onAddLocalSource}
          onRequestDocumentReference={requestDocumentReference}
        />
        <AgentModelPicker
          className="agent-ai-model-picker"
          variant="compact"
          menuPlacement="top"
          value={selectedModelKey}
          options={modelOptions}
          onChange={onModelChange}
          disabled={busy || !modelOptions.length}
        />
        {needsModelConfig ? (
          <button type="button" className="agent-ai-configure" onClick={onConfigureModel}>
            Configure
          </button>
        ) : hostedAccountStatus && hostedAccountStatus !== 'ready' ? (
          <button
            type="button"
            className="agent-ai-configure"
            onClick={hostedAccountStatus === 'credits_empty'
              ? onHostedAccountBilling
              : hostedAccountStatus === 'connecting'
                ? onHostedAccountCancel
                : onHostedAccountConnect}
            disabled={hostedAccountStatus === 'loading'}
            data-testid="agent-composer-kition-account"
          >
            {hostedAccountStatus === 'credits_empty'
              ? t('emptyState.kitionAccount.topUp')
              : hostedAccountStatus === 'loading'
              ? t('emptyState.kitionAccount.checking')
              : hostedAccountStatus === 'connecting'
                ? t('emptyState.kitionAccount.cancel')
                : hostedAccountStatus === 'temporary_error'
                  ? t('emptyState.kitionAccount.retry')
                  : hostedAccountStatus === 'expired'
                    ? t('emptyState.kitionAccount.signInAgain')
                    : t('emptyState.kitionAccount.signIn')}
          </button>
        ) : null}
        <button
          type="button"
          className="agent-ai-send"
          aria-label={busy ? 'Stop' : 'Send'}
          title={busy ? 'Stop' : 'Send'}
          onClick={busy ? onStop : onSend}
          disabled={busy ? false : (!canSend || needsModelConfig)}
        >
          {busy ? <X className="size-4" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </div>
  )
}
