import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'

import { Button } from '@/components/ui'
import { openExternalURL } from '@/services/desktop'
import {
  type ConsoleCreditsExhaustedDetail,
  subscribeConsoleCreditsExhausted,
} from '@/services/consoleCredits'

/**
 * Non-blocking banner that surfaces the structured `credits_exhausted` error
 * returned by the KitionAI Console hosted LLM proxy. The banner is dismissable
 * and re-appears whenever a new credits-exhausted event fires, so the user can
 * close it and keep working with a different provider without it lingering.
 */
export function ConsoleCreditsExhaustedBanner() {
  const [detail, setDetail] = useState<ConsoleCreditsExhaustedDetail | null>(null)

  useEffect(() => {
    return subscribeConsoleCreditsExhausted((next) => {
      setDetail(next)
    })
  }, [])

  if (!detail) {
    return null
  }

  return (
    <div
      className="console-credits-banner"
      role="alert"
      data-testid="console-credits-exhausted-banner"
    >
      <div className="console-credits-banner__icon" aria-hidden="true">
        <AlertTriangle className="size-5" />
      </div>
      <div className="console-credits-banner__copy">
        <p className="console-credits-banner__title">Kition credits are exhausted</p>
        <p className="console-credits-banner__message">{detail.message}</p>
      </div>
      <div className="console-credits-banner__actions">
        {detail.topupUrl ? (
          <Button
            type="button"
            className="console-credits-banner__primary"
            onClick={() => void openExternalURL(detail.topupUrl)}
            data-testid="console-credits-exhausted-topup"
          >
            <ExternalLink className="size-4" />
            Top up credits
          </Button>
        ) : null}
        <button
          type="button"
          className="console-credits-banner__close"
          onClick={() => setDetail(null)}
          aria-label="Dismiss"
          title="Dismiss"
          data-testid="console-credits-exhausted-dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
