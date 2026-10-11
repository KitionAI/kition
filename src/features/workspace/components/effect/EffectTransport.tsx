import { useTranslation } from 'react-i18next'
import { Pause, Play, Plus, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react'
import { ActionMenu, ActionMenuContent, ActionMenuItem, ActionMenuTrigger } from '@/components/ActionMenu'
import { Button } from '@/components/ui'
import { effectTimecode, type EffectState } from './effectKitSdk'

/** The layers the add menu makes, as engine commands. */
const NEW_LAYERS = [
  { id: 'text', command: 'layer.newText', params: { text: 'Text' } },
  { id: 'shape', command: 'layer.newShape', params: { kind: 'rect' } },
  { id: 'solid', command: 'layer.newSolid', params: {} },
  { id: 'null', command: 'layer.newNull', params: {} },
  { id: 'adjustment', command: 'layer.newAdjustment', params: {} },
] as const

type EffectTransportProps = {
  effect: EffectState
  playing: boolean
  onPlay: () => void
  onSeek: (seconds: number) => void
  onStep: (frames: number) => void
  onNewLayer: (command: string, params: Record<string, unknown>) => void
}

/** Add a layer, play, step, and jump, under the composition viewer. */
export function EffectTransport({ effect, playing, onPlay, onSeek, onStep, onNewLayer }: EffectTransportProps) {
  const { t } = useTranslation('workspace')
  const fps = effect.comp?.fps ?? 30
  const end = Math.max(0, (effect.comp?.duration ?? 0) - effect.frame)
  const button = 'size-8'
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border bg-background px-3" data-testid="effect-transport">
      <ActionMenu>
        <ActionMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="effect-new-layer">
            <Plus className="size-3.5" aria-hidden="true" />
            {t('effectKit.newLayer')}
          </Button>
        </ActionMenuTrigger>
        <ActionMenuContent align="start" side="top">
          {NEW_LAYERS.map((layer) => (
            <ActionMenuItem key={layer.id} onSelect={() => onNewLayer(layer.command, { ...layer.params })} data-testid={`effect-new-${layer.id}`}>
              {t(`effectKit.layerKind.${layer.id}`)}
            </ActionMenuItem>
          ))}
        </ActionMenuContent>
      </ActionMenu>
      <div className="flex-1" />
      <Button variant="ghost" size="icon" className={button} aria-label={t('effectKit.goToStart')} title={t('effectKit.goToStart')} onClick={() => onSeek(0)}>
        <SkipBack className="size-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('effectKit.stepBack')} title={t('effectKit.stepBack')} onClick={() => onStep(-1)}>
        <StepBack className="size-4" aria-hidden="true" />
      </Button>
      <Button size="icon" className="size-9" aria-label={playing ? t('effectKit.pause') : t('effectKit.play')} title={`${playing ? t('effectKit.pause') : t('effectKit.play')} (Space)`} onClick={onPlay} data-testid="effect-play">
        {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('effectKit.stepForward')} title={t('effectKit.stepForward')} onClick={() => onStep(1)}>
        <StepForward className="size-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('effectKit.goToEnd')} title={t('effectKit.goToEnd')} onClick={() => onSeek(end)}>
        <SkipForward className="size-4" aria-hidden="true" />
      </Button>
      <span className="ml-2 font-mono text-[13px] tabular-nums text-foreground" data-testid="effect-timecode">{effectTimecode(effect.time, fps)}</span>
      <span className="font-mono text-[13px] tabular-nums text-muted-foreground">/ {effectTimecode(effect.comp?.duration ?? 0, fps)}</span>
      <div className="flex-1" />
    </div>
  )
}
