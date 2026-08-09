import { useState, type FormEvent } from 'react'
import { CheckCircle2, LoaderCircle, MessageSquareText } from 'lucide-react'

import { Button, Card, Input, Textarea } from '@/components/ui'
import { useTranslation } from '@/i18n'
import { submitFeedbackReport } from '@/services/desktop'

const MIN_FEEDBACK_LENGTH = 10
const MAX_FEEDBACK_LENGTH = 500

export function FeedbackForm({
  accessToken,
  initialEmail,
  onClose,
}: {
  accessToken?: string
  initialEmail?: string
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [message, setMessage] = useState('')
  const [contactEmail, setContactEmail] = useState(initialEmail || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [ticketId, setTicketId] = useState('')
  const messageLength = Array.from(message.trim()).length
  const canSubmit = messageLength >= MIN_FEEDBACK_LENGTH && messageLength <= MAX_FEEDBACK_LENGTH

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || submitting) return

    setSubmitting(true)
    setError('')
    try {
      const result = await submitFeedbackReport({
        description: message.trim(),
        contact_email: contactEmail.trim(),
        access_token: accessToken,
      })
      setTicketId(result.ticket_id)
    } catch {
      setError(t('about.feedbackSubmitFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  if (ticketId) {
    return (
      <div className="py-4" data-testid="feedback-form">
        <Card className="space-y-4 p-5">
          <div className="flex items-start gap-3" role="status">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[hsl(var(--success-foreground))]" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <strong className="block text-sm font-semibold text-foreground">{t('about.feedbackSuccessTitle')}</strong>
              <p className="text-sm leading-6 text-muted-foreground">{t('about.feedbackSuccessDescription')}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {t('about.feedbackTicketId', { ticketId })}
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('about.feedbackDone')}</Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="py-4" data-testid="feedback-form">
      <Card className="p-5">
        <form className="space-y-5" onSubmit={(event) => void submit(event)}>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <MessageSquareText className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <strong className="block text-sm font-semibold text-foreground">{t('about.feedbackFormTitle')}</strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('about.feedbackFormDescription')}</p>
            </div>
          </div>

          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('about.feedbackMessageLabel')}</span>
            <Textarea
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
                setError('')
              }}
              maxLength={MAX_FEEDBACK_LENGTH}
              rows={6}
              autoFocus
              disabled={submitting}
              placeholder={t('about.feedbackMessagePlaceholder')}
              data-testid="feedback-message"
            />
            <span className="flex items-center justify-between gap-3 text-xs font-normal text-muted-foreground">
              <span>{t('about.feedbackMessageHint', { min: MIN_FEEDBACK_LENGTH })}</span>
              <span>{t('about.feedbackCharacterCount', { count: messageLength, max: MAX_FEEDBACK_LENGTH })}</span>
            </span>
          </label>

          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('about.feedbackEmailLabel')}</span>
            <Input
              type="email"
              value={contactEmail}
              onChange={(event) => {
                setContactEmail(event.target.value)
                setError('')
              }}
              maxLength={254}
              disabled={submitting}
              placeholder={t('about.feedbackEmailPlaceholder')}
              data-testid="feedback-email"
            />
          </label>

          <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t('about.feedbackPrivacyNote')}
          </p>

          {error ? <div className="settings-feedback" role="alert">{error}</div> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('about.feedbackCancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              {submitting ? t('about.feedbackSubmitting') : t('about.feedbackSubmit')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
