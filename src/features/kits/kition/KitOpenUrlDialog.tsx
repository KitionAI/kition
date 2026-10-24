import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@kition/app-ui'
import { openExternalURL } from '@/services/desktop'
import type { KitOpenResult } from '../host/mountKit'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@kition/app-ui/dialog'

/**
 * What the confirmation shows of a web address a kit asks to open (KitLinks 1.0 OP8): the whole
 * address, the site's host name as written, and its ASCII form when the two differ (a non-ASCII
 * name, which could imitate another site). `null` for an address with no host.
 */
export function openUrlParts(url: string): { address: string; host: string; asciiHost: string | null } | null {
  const mail = /^mailto:/i.test(url)
  const written = mail ? /@([^?&>]+)/.exec(url)?.[1] : /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url)?.[1]
  if (!written) return null
  let ascii: string
  try {
    ascii = new URL(`http://${written}`).hostname
  } catch {
    return null
  }
  const host = written.toLowerCase()
  return { address: url, host, asciiHost: ascii !== host ? ascii : null }
}

/** Asks the person before Kition opens a web address a kit asked for (OP8); `onSettle(true)` opens it. */
function KitOpenUrlDialog({ url, onSettle }: { url: string; onSettle: (open: boolean) => void }) {
  const { t } = useTranslation('workspace')
  const parts = openUrlParts(url)
  return (
    <Dialog open onOpenChange={(open) => !open && onSettle(false)}>
      <DialogContent size="sm" data-testid="kit-open-url-dialog">
        <DialogHeader>
          <DialogTitle>{t('kitEditor.openUrl.title')}</DialogTitle>
          <DialogDescription>{t('kitEditor.openUrl.body')}</DialogDescription>
        </DialogHeader>
        {parts ? (
          <div className="space-y-2 text-[13px]">
            <p>
              {t('kitEditor.openUrl.site')} <strong className="font-semibold text-foreground" data-testid="kit-open-url-host">{parts.host}</strong>
              {parts.asciiHost ? <span className="ml-1 text-muted-foreground" data-testid="kit-open-url-ascii">({t('kitEditor.openUrl.ascii', { host: parts.asciiHost })})</span> : null}
            </p>
            <p className="break-all rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]" data-testid="kit-open-url-address">
              {parts.address}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onSettle(false)} data-testid="kit-open-url-cancel">
            {t('kitEditor.openUrl.cancel')}
          </Button>
          <Button onClick={() => onSettle(true)} data-testid="kit-open-url-open">
            {t('kitEditor.openUrl.open')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Asks the person about each web address a kit asks to open (`ask` answers whether they chose to
 * open it); `dialog` is the question while one is asked.
 */
export function useOpenUrlConfirmation(): { ask: (url: string) => Promise<boolean>; dialog: ReactNode } {
  const [asked, setAsked] = useState<{ url: string; settle: (open: boolean) => void } | null>(null)
  const ask = useCallback((url: string) => new Promise<boolean>((settle) => setAsked({ url, settle })), [])
  const dialog = asked ? (
    <KitOpenUrlDialog
      url={asked.url}
      onSettle={(open) => {
        asked.settle(open)
        setAsked(null)
      }}
    />
  ) : null
  return { ask, dialog }
}

/** `host/openUrl`: opens the address in the system's browser or mail client once `ask` answered yes (OP8, OP9). */
export function openConfirmedUrl(ask: (url: string) => Promise<boolean>) {
  return async ({ url }: { url: string }): Promise<KitOpenResult> => {
    if (!(await ask(url))) return { opened: false }
    await openExternalURL(url)
    return { opened: true }
  }
}
