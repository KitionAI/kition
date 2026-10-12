import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { KitsPhotoDetails } from '@/api/kits'
import { cn } from '@/lib/utils'

type PhotoSidePanelProps = {
  details: KitsPhotoDetails | null
  /** Runs a kit command as a person would from the editor's own panel. */
  onRun: (command: string, params?: Record<string, unknown>) => void
}

function percent(value: number | null | undefined) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—'
}

/** Layers and properties of the open image, in Kition's panel style. */
export function PhotoSidePanel({ details, onRun }: PhotoSidePanelProps) {
  const { t } = useTranslation('workspace')
  const layers = details?.layers ?? []
  const selected = layers.find((layer) => layer.id === details?.activeLayer) ?? layers.find((layer) => layer.selected)
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border" aria-label={t('photoKit.layers')} data-testid="photo-side-panel">
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
          <p className="flex-1 text-[13px] font-semibold text-foreground">{t('photoKit.layers')}</p>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={t('photoKit.newLayer')} aria-label={t('photoKit.newLayer')} onClick={() => onRun('layer.new.layer')} data-testid="photo-layer-new">
            <Plus className="size-4" aria-hidden="true" />
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" title={t('photoKit.duplicateLayer')} aria-label={t('photoKit.duplicateLayer')} disabled={!selected} onClick={() => onRun('layer.duplicate')}>
            <Copy className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" title={t('photoKit.deleteLayer')} aria-label={t('photoKit.deleteLayer')} disabled={!selected || layers.length < 2} onClick={() => onRun('layer.delete')}>
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="photo-kit-layers">
          {layers.length ? layers.map((layer, index) => {
            const isSelected = layer.id === selected?.id
            return (
              <li key={layer.id ?? `${index}:${layer.name}`}>
                <div
                  className={cn(
                    'mx-1.5 flex h-8 items-center gap-1.5 rounded-md pr-2 text-[13px]',
                    isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
                    !layer.visible && 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: 6 + (layer.depth ?? 0) * 14 }}
                >
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    aria-label={layer.visible ? t('photoKit.hideLayer') : t('photoKit.showLayer')}
                    title={layer.visible ? t('photoKit.hideLayer') : t('photoKit.showLayer')}
                    onClick={() => onRun('layer.setProps', { layer: layer.id, visible: !layer.visible })}
                    data-testid={`photo-layer-visibility-${layer.id}`}
                  >
                    {layer.visible ? <Eye className="size-3.5" aria-hidden="true" /> : <EyeOff className="size-3.5" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
                    onClick={() => onRun('layer.select', { layer: layer.id, mode: 'replace' })}
                    aria-pressed={isSelected}
                    data-testid={`photo-layer-${layer.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{layer.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{layer.kind}</span>
                  </button>
                </div>
              </li>
            )
          }) : <li className="px-3 py-2 text-[13px] text-muted-foreground">{t('photoKit.noLayers')}</li>}
        </ul>
      </section>
      <section className="shrink-0 border-t border-border px-3 py-2.5" data-testid="photo-properties">
        <p className="text-[13px] font-semibold text-foreground">{t('photoKit.properties')}</p>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('photoKit.canvasSize')}</dt>
          <dd className="text-foreground">{details ? `${details.width} × ${details.height} px` : '—'}</dd>
          <dt className="text-muted-foreground">{t('photoKit.colorMode')}</dt>
          <dd className="text-foreground">{details ? `${details.mode}, ${details.depth}-bit` : '—'}</dd>
          {selected ? (
            <>
              <dt className="text-muted-foreground">{t('photoKit.layer')}</dt>
              <dd className="truncate text-foreground">{selected.name}</dd>
              <dt className="text-muted-foreground">{t('photoKit.opacity')}</dt>
              <dd className="text-foreground">{percent(selected.opacity)}</dd>
              <dt className="text-muted-foreground">{t('photoKit.blendMode')}</dt>
              <dd className="text-foreground">{selected.blend ?? '—'}</dd>
            </>
          ) : null}
        </dl>
      </section>
    </aside>
  )
}
