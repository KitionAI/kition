import { useTranslation } from 'react-i18next'
import { LayoutTemplate } from 'lucide-react'

/** Shown for layouts when this build has no Design engine. */
export function DesignUnavailable() {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid="design-unavailable">
      <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
        <LayoutTemplate className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-[15px] font-semibold text-foreground">{t('designKit.unavailableTitle')}</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('designKit.unavailableBody')}</p>
      </div>
    </div>
  )
}
