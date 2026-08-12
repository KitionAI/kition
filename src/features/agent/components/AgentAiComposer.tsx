import { ArrowUp, FileText, Folder, X } from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
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
  stripAgentDocumentMentions,
  type AgentMentionableDocument,
} from '@/features/agent/lib/documentMentions'
import { cn } from '@/lib/utils'

type AgentAiComposerProps = {
  busy: boolean
  canSend: boolean
  compact?: boolean
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const visibleDraft = stripAgentDocumentMentions(draft)
  const documentsByPath = new Map(
    mentionableDocuments.map((document) => [document.path, document]),
  )
  const contextDocuments = documentContextPaths.map((path) => ({
    path,
    kind: documentsByPath.get(path)?.kind,
  }))
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
  const filteredMentions = mentionQuery
    ? mentionableDocuments
        .filter((document) => {
          if (documentContextPaths.includes(document.path)) {
            return false
          }
          const keyword = `${document.title} ${document.name} ${document.path}`.toLowerCase()
          return keyword.includes(mentionQuery.query.trim().toLowerCase())
        })
        .slice(0, 8)
    : []

  useEffect(() => {
    setHighlightedMentionIndex(0)
  }, [mentionQuery?.query])

  function updateVisibleDraft(nextVisibleDraft: string) {
    onDraftChange(nextVisibleDraft)
  }

  function selectMention(document: AgentMentionableDocument) {
    if (!mentionQuery) {
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
          if (mentionQuery && filteredMentions.length) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlightedMentionIndex((current) =>
                Math.min(filteredMentions.length - 1, current + 1),
              )
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlightedMentionIndex((current) => Math.max(0, current - 1))
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              const selectedMention =
                filteredMentions[highlightedMentionIndex] || filteredMentions[0]
              if (selectedMention) {
                selectMention(selectedMention)
              }
              return
            }
          }
          onKeyDown(event)
        }}
        placeholder="Plan, write, or ask anything…"
        disabled={busy}
      />
      {mentionQuery && filteredMentions.length ? (
        <div className="agent-mention-menu">
          {filteredMentions.map((document, index) => (
            <button
              key={document.path}
              type="button"
              className={cn(
                'agent-mention-menu__item',
                index === highlightedMentionIndex && 'is-active',
              )}
              onMouseDown={(event) => {
                event.preventDefault()
                selectMention(document)
              }}
            >
              {document.kind === 'folder' ? (
                <Folder className="agent-mention-menu__icon size-4 shrink-0" />
              ) : (
                <FileText className="agent-mention-menu__icon size-4 shrink-0" />
              )}
              <span className="agent-mention-menu__text">
                <strong>{document.title}</strong>
                <span>{document.path}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="agent-ai-footer">
        <AgentContextAddMenu
          disabled={busy}
          localSourceCount={localSources.length}
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
