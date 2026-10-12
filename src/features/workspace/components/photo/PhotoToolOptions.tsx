import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

type PhotoToolOptionsProps = {
  tool: string
  shapeKind: 'rect' | 'ellipse'
  onShapeKind: (kind: 'rect' | 'ellipse') => void
  fontSize: number
  onFontSize: (size: number) => void
  cropProposed: boolean
  cloneSourceSet: boolean
  onApplyCrop: () => void
  onCancelCrop: () => void
}

/** The options bar's part that belongs to one tool: shape kind, font size, crop actions. */
export function PhotoToolOptions(props: PhotoToolOptionsProps) {
  const { t } = useTranslation('workspace')
  if (props.tool === 'Rectangle') {
    return (
      <div className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5" role="radiogroup" aria-label={t('photoKit.tools.shape')}>
        {(['rect', 'ellipse'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={props.shapeKind === kind}
            className={cn('h-7 rounded-md px-2.5 text-[13px] text-muted-foreground', props.shapeKind === kind && 'bg-background text-foreground shadow-sm')}
            onClick={() => props.onShapeKind(kind)}
          >
            {t(kind === 'rect' ? 'photoKit.shapeRect' : 'photoKit.shapeEllipse')}
          </button>
        ))}
      </div>
    )
  }
  if (props.tool === 'Type') {
    return (
      <label className="flex items-center gap-2 text-muted-foreground">
        {t('photoKit.fontSize')}
        <input
          type="number"
          min={4}
          max={1000}
          value={props.fontSize}
          onChange={(event) => props.onFontSize(Math.max(4, Math.min(1000, Number(event.target.value) || 4)))}
          className="h-7 w-16 rounded-md border border-border bg-background px-2 tabular-nums text-foreground"
          data-testid="photo-font-size"
        />
        px
      </label>
    )
  }
  if (props.tool === 'CloneStamp' && !props.cloneSourceSet) {
    return <span className="text-muted-foreground" data-testid="photo-clone-hint">{t('photoKit.cloneHint')}</span>
  }
  if (props.tool === 'Crop' && props.cropProposed) {
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={props.onApplyCrop} data-testid="photo-crop-apply">{t('photoKit.applyCrop')}</Button>
        <Button variant="ghost" size="sm" onClick={props.onCancelCrop}>{t('photoKit.cancel')}</Button>
      </div>
    )
  }
  return null
}
