import { useTranslation } from 'react-i18next'
import { PenTool } from 'lucide-react'

/** Shown for vector drawings when this build has no Vector engine. */
export function VectorUnavailable() {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid="vector-unavailable">
      <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
        <PenTool className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-[15px] font-semibold text-foreground">{t('vectorKit.unavailableTitle')}</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('vectorKit.unavailableBody')}</p>
      </div>
    </div>
  )
}
