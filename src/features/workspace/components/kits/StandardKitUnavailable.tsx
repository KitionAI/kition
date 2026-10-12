import { useTranslation } from 'react-i18next'
import type { StandardKitSpec } from './standardKits'

/** Shown for a kit's files when this build has no engine for it. */
export function StandardKitUnavailable({ spec }: { spec: Pick<StandardKitSpec, 'key' | 'icon'> }) {
  const { t } = useTranslation('workspace')
  const Icon = spec.icon
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid={`${spec.key}-unavailable`}>
      <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
        <Icon className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-[15px] font-semibold text-foreground">{t(`${spec.key}Kit.unavailableTitle`)}</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t(`${spec.key}Kit.unavailableBody`)}</p>
      </div>
    </div>
  )
}
