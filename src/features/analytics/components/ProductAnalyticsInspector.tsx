import { useSyncExternalStore } from 'react'
import { ListChecks, Trash2 } from 'lucide-react'

import { Button, Disclosure } from '@/components/ui'
import {
  clearProductAnalyticsQueue,
  getProductAnalyticsQueue,
  subscribeProductAnalyticsQueue,
} from '@/features/analytics/lib/productAnalytics'
import { SettingsRow, SettingsSection } from '@/features/settings/primitives'
import { getCurrentLocale, useTranslation } from '@/i18n'

export function ProductAnalyticsInspector() {
  const { t } = useTranslation('settings')
  const events = useSyncExternalStore(
    subscribeProductAnalyticsQueue,
    getProductAnalyticsQueue,
    getProductAnalyticsQueue,
  )
  const recentEvents = events.slice(-20).reverse()

  return (
    <SettingsSection
      title={t('general.analyticsInspector')}
      description={t('general.analyticsInspectorDescription')}
      className="analytics-inspector"
    >
      <SettingsRow
        title={t('general.analyticsQueuedEvents')}
        description={t('general.analyticsQueuedEventsDescription', { count: events.length })}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={clearProductAnalyticsQueue}
          disabled={events.length === 0}
          data-testid="clear-analytics-events"
        >
          <Trash2 className="size-4" />
          {t('general.analyticsClearQueue')}
        </Button>
      </SettingsRow>
      <Disclosure title={t('general.analyticsRecentEvents')}>
        {recentEvents.length ? (
          <div className="divide-y divide-border" data-testid="analytics-event-inspector">
            {recentEvents.map((event) => (
              <details key={event.id} className="py-2 text-xs">
                <summary className="cursor-pointer list-none">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <ListChecks className="size-4 shrink-0 text-muted-foreground" />
                    <code className="min-w-0 flex-1 truncate text-foreground">{event.name}</code>
                    <span className="shrink-0 text-muted-foreground">
                      {new Date(event.occurred_at).toLocaleString(getCurrentLocale(), { hour12: false })}
                    </span>
                  </span>
                </summary>
                <pre className="mt-2 max-w-full whitespace-pre-wrap break-all rounded-md bg-muted/45 p-3 text-[11px] leading-5 text-muted-foreground">
                  {JSON.stringify(event, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">{t('general.analyticsNoEvents')}</p>
        )}
      </Disclosure>
    </SettingsSection>
  )
}
