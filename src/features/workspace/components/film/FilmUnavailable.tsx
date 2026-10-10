import { useTranslation } from 'react-i18next'
import { Clapperboard } from 'lucide-react'

/** Shown for video projects when this build has no Film engine. */
export function FilmUnavailable() {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid="film-unavailable">
      <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
        <Clapperboard className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-[15px] font-semibold text-foreground">{t('filmKit.unavailableTitle')}</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('filmKit.unavailableBody')}</p>
      </div>
    </div>
  )
}
