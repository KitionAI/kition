import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Diamond } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EffectProperty, EffectState } from './effectKitSdk'

type EffectPropertiesPanelProps = {
  effect: EffectState | null
  onRun: (command: string, params: Record<string, unknown>) => void
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

/** One number of a property; commits on Enter or blur. */
function NumberField({ value, label, onCommit, testId }: { value: number; label: string; onCommit: (value: number) => void; testId: string }) {
  const [text, setText] = useState(String(round(value)))
  useEffect(() => setText(String(round(value))), [value])
  const commit = () => {
    const next = Number(text)
    if (Number.isFinite(next) && next !== round(value)) onCommit(next)
    else setText(String(round(value)))
  }
  return (
    <input
      className="h-7 w-full min-w-0 rounded-md border border-border bg-background px-1.5 text-right text-[12px] tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={label}
      value={text}
      inputMode="decimal"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setText(String(round(value)))
          event.currentTarget.blur()
        }
      }}
      data-testid={testId}
    />
  )
}

/** How many numbers a property shows: 2D layers show x and y of a 3D value. */
function dims(property: EffectProperty) {
  return Array.isArray(property.value) ? Math.min(2, property.value.length) : 1
}

/**
 * The selected layer's transform at the current time, as in After Effects'
 * Transform group: edit a value, or add a keyframe here with the diamond.
 * Once a property has keyframes, edits set a keyframe at the current time.
 */
export function EffectPropertiesPanel({ effect, onRun }: EffectPropertiesPanelProps) {
  const { t } = useTranslation('workspace')
  const transform = effect?.transform
  const layer = transform ? effect?.layers.find((item) => item.id === transform.layer) : null
  const time = effect?.time ?? 0

  const set = (property: EffectProperty, index: number, next: number) => {
    const value = Array.isArray(property.value) ? property.value.map((part, at) => (at === index ? next : part)) : next
    onRun('prop.set', { layer: transform?.layer, path: property.path, value, time, timeBase: 'comp' })
  }

  return (
    <div className="flex w-64 shrink-0 flex-col border-l border-border" data-testid="effect-properties-panel">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-[12px] font-medium text-foreground">
        <span className="truncate">{layer ? layer.name : t('effectKit.properties')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {transform && layer ? (
          <div className="flex flex-col gap-2">
            {transform.properties.map((property) => (
              <div key={property.path} className="flex items-center gap-1.5" data-testid={`effect-prop-${property.path.split('/').pop()}`}>
                <button
                  type="button"
                  className={cn('flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted', property.animated ? 'text-primary' : 'text-muted-foreground')}
                  aria-label={t('effectKit.addKey', { name: property.name })}
                  title={t('effectKit.addKey', { name: property.name })}
                  onClick={() => onRun('prop.addKey', { layer: transform.layer, path: property.path, time, timeBase: 'comp' })}
                  data-testid={`effect-add-key-${property.path.split('/').pop()}`}
                >
                  <Diamond className={cn('size-3', property.animated && 'fill-current')} aria-hidden="true" />
                </button>
                <span className="w-20 shrink-0 truncate text-[12px] text-muted-foreground">{property.name}</span>
                <div className="flex min-w-0 flex-1 gap-1">
                  {Array.from({ length: dims(property) }, (_, index) => (
                    <NumberField
                      key={index}
                      value={Array.isArray(property.value) ? property.value[index] ?? 0 : property.value}
                      label={`${property.name} ${index + 1}`}
                      onCommit={(next) => set(property, index, next)}
                      testId={`effect-value-${property.path.split('/').pop()}-${index}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('effectKit.selectLayer')}</p>
        )}
      </div>
    </div>
  )
}
