import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { PHOTO_TOOLS, cssColor } from './photoTools'

type PhotoToolRailProps = {
  tool: string | null | undefined
  foreground?: readonly number[] | null
  background?: readonly number[] | null
  onSelect: (tool: string) => void
}

/** The editor's tools, one column on the left of the canvas. */
export function PhotoToolRail({ tool, foreground, background, onSelect }: PhotoToolRailProps) {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border py-2" role="toolbar" aria-orientation="vertical" aria-label={t('photoKit.toolsLabel')} data-testid="photo-tool-rail">
      {PHOTO_TOOLS.map((item) => {
        const Icon = item.icon
        const active = item.id === tool
        const label = `${t(`photoKit.tools.${item.label}`)} (${item.shortcut})`
        return (
          <button
            key={item.id}
            type="button"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors',
              'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              active && 'bg-accent text-accent-foreground',
            )}
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => onSelect(item.id)}
            data-testid={`photo-tool-${item.id}`}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        )
      })}
      <div className="relative mt-2 size-8 shrink-0" aria-label={t('photoKit.colors')} title={t('photoKit.colors')}>
        <span className="absolute bottom-0 right-0 size-5 rounded-md border border-border" style={{ background: cssColor(background) }} />
        <span className="absolute left-0 top-0 size-5 rounded-md border border-border shadow-sm" style={{ background: cssColor(foreground) }} />
      </div>
    </div>
  )
}
