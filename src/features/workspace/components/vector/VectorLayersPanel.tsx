import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VectorLayer, VectorState } from './vectorKitSdk'

type VectorLayersPanelProps = {
  state: VectorState | null
  onRun: (command: string, params: Record<string, unknown>) => void
}

function Row({ item, depth, selected, onRun }: { item: VectorLayer; depth: number; selected: ReadonlySet<number>; onRun: VectorLayersPanelProps['onRun'] }) {
  const { t } = useTranslation('workspace')
  const isLayer = item.kind === 'Layer'
  return (
    <>
      <div
        className={cn('flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-[12px] text-foreground hover:bg-muted', selected.has(item.id) && 'bg-accent text-accent-foreground')}
        style={{ paddingLeft: 6 + depth * 12 }}
        data-testid={`vector-layer-${item.id}`}
      >
        {isLayer ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={item.visible ? t('vectorKit.hideLayer') : t('vectorKit.showLayer')}
            aria-pressed={item.visible}
            onClick={() => onRun('layer.setProps', { id: item.id, visible: !item.visible })}
            data-testid={`vector-layer-visibility-${item.id}`}
          >
            {item.visible ? <Eye className="size-3.5" aria-hidden="true" /> : <EyeOff className="size-3.5" aria-hidden="true" />}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        {isLayer && item.color ? <span className="size-2 shrink-0 rounded-sm" style={{ background: item.color }} aria-hidden="true" /> : null}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left outline-none"
          onClick={() => onRun(isLayer ? 'layer.selectAll' : 'select.set', isLayer ? { id: item.id } : { ids: [item.id] })}
        >
          {item.name}
        </button>
        {item.locked ? <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={t('vectorKit.locked')} /> : null}
      </div>
      {item.children.map((child) => (
        <Row key={child.id} item={child} depth={depth + 1} selected={selected} onRun={onRun} />
      ))}
    </>
  )
}

/** The drawing's layers and their objects; a click selects, the eye shows or hides a layer. */
export function VectorLayersPanel({ state, onRun }: VectorLayersPanelProps) {
  const { t } = useTranslation('workspace')
  const selected = new Set(state?.selection ?? [])
  return (
    <div className="flex w-60 shrink-0 flex-col border-l border-border" data-testid="vector-layers-panel">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-[12px] font-medium text-foreground">{t('vectorKit.layers')}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {state?.layers.map((layer) => (
          <Row key={layer.id} item={layer} depth={0} selected={selected} onRun={onRun} />
        ))}
      </div>
    </div>
  )
}
