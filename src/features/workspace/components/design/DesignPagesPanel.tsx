import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui'
import type { RasterRect } from '@/features/kits/public'
import type { DesignState } from './designKitSdk'

type DesignPagesPanelProps = {
  state: DesignState | null
  onShow: (area: RasterRect) => void
  onAddPage: () => void
}

/** The layout's spreads and pages, as InDesign's Pages panel: a click brings a spread into view. */
export function DesignPagesPanel({ state, onShow, onAddPage }: DesignPagesPanelProps) {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex w-56 shrink-0 flex-col border-l border-border" data-testid="design-pages-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5 text-[12px] font-medium text-foreground">
        <span>{t('designKit.pages')}</span>
        <Button variant="ghost" size="icon" className="size-7" aria-label={t('designKit.addPage')} title={t('designKit.addPage')} onClick={onAddPage} data-testid="design-add-page">
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {state?.spreads.map((spread) => {
          const aspect = (spread.area.x1 - spread.area.x0) / Math.max(1, spread.area.y1 - spread.area.y0)
          return (
            <button
              key={spread.index}
              type="button"
              className="flex w-full flex-col items-center gap-1 rounded-lg p-2 text-[11px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onShow(spread.area)}
              data-testid={`design-spread-${spread.index}`}
            >
              <span className="block rounded-sm border border-border bg-background shadow-sm" style={{ width: Math.min(120, 72 * aspect), height: Math.min(120, 72 * aspect) / aspect }} aria-hidden="true" />
              <span className="tabular-nums">{spread.pages.join('–')}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
