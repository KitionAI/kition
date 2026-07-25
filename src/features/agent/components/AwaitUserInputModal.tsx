import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleHelp, Send } from 'lucide-react'

import type { AgentToolCall } from '@/api/agent'
import { cn } from '@/lib/utils'

// Render the await_user_input interrupt produced by the request_user_input
// runtime tool. Codex parity §5: the tool returns Interrupt: 'await_user_input'
// with Output: { question, options, mode } and yields the loop; the model
// resumes only after the user replies via the chat input. The modal mirrors
// PlanCard's pattern — pure read of the latest tool call, no live state of its
// own, leaving the message-send wiring to the caller.

export type AwaitUserInputMode = 'text' | 'choice' | 'yes_no' | string

export type AwaitUserInputRequest = {
  toolCallId: number
  question: string
  options: string[]
  mode: AwaitUserInputMode
}

export function readLatestAwaitUserInputRequest(
  toolCalls: AgentToolCall[],
): AwaitUserInputRequest | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i]
    if (call.tool_name !== 'request_user_input') continue
    // A completed tool call means the user already replied; skip it so we only
    // surface the currently outstanding request.
    if (call.status === 'completed' || call.status === 'failed') continue
    const output = (call.output_data ?? {}) as {
      question?: unknown
      options?: unknown
      mode?: unknown
    }
    const question = typeof output.question === 'string' ? output.question.trim() : ''
    if (!question) continue
    const rawOptions = Array.isArray(output.options) ? output.options : []
    const options = rawOptions
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
    const mode = typeof output.mode === 'string' && output.mode.length > 0 ? output.mode : 'text'
    return { toolCallId: call.id, question, options, mode }
  }
  return null
}

export type AwaitUserInputModalProps = {
  request: AwaitUserInputRequest
  onSubmit?: (answer: string, request: AwaitUserInputRequest) => void
  busy?: boolean
}

export function AwaitUserInputModal({ request, onSubmit, busy }: AwaitUserInputModalProps) {
  const { t } = useTranslation('agent')
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  // Reset when a new request comes in so the previous reply doesn't leak.
  useEffect(() => {
    setDraft('')
    setSelected(null)
  }, [request.toolCallId])

  const yesNoOptions = useMemo(() => {
    if (request.mode !== 'yes_no') return null
    return request.options.length > 0 ? request.options : [t('awaitInput.yes'), t('awaitInput.no')]
  }, [request.mode, request.options, t])

  const submit = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    onSubmit?.(trimmed, request)
  }

  return (
    <div className="await-user-input">
      <div className="await-user-input-head">
        <CircleHelp className="size-3.5" aria-hidden />
        <span className="await-user-input-eyebrow">{t('awaitInput.waitingForReply')}</span>
      </div>
      <p className="await-user-input-question">{request.question}</p>

      {yesNoOptions ? (
        <div className="await-user-input-actions">
          {yesNoOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                'await-user-input-action',
                selected === option && 'is-selected',
              )}
              disabled={busy}
              onClick={() => {
                setSelected(option)
                submit(option)
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {request.mode === 'choice' && request.options.length > 0 ? (
        <div className="await-user-input-choices">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                'await-user-input-choice',
                selected === option && 'is-selected',
              )}
              disabled={busy}
              onClick={() => {
                setSelected(option)
                submit(option)
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {request.mode !== 'yes_no' && (request.mode !== 'choice' || request.options.length === 0) ? (
        <form
          className="await-user-input-form"
          onSubmit={(event) => {
            event.preventDefault()
            submit(draft)
          }}
        >
          <textarea
            className="await-user-input-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('awaitInput.replyPlaceholder')}
            rows={2}
            disabled={busy}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                submit(draft)
              }
            }}
          />
          <button
            type="submit"
            className="await-user-input-submit"
            disabled={busy || draft.trim().length === 0}
          >
            <Send className="size-3.5" aria-hidden />
            <span>{t('awaitInput.send')}</span>
          </button>
        </form>
      ) : null}
    </div>
  )
}
