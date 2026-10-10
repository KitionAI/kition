import { useTranslation } from 'react-i18next'
import { Pause, Play, Scissors, SkipBack, SkipForward, StepBack, StepForward, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui'
import { timecode, type FilmState } from './filmKitSdk'
import { FilmMediaMenu } from './FilmMediaMenu'

type FilmTransportProps = {
  film: FilmState
  playing: boolean
  onPlay: () => void
  muted: boolean
  onMute: () => void
  onSeek: (seconds: number) => void
  onStep: (frames: number) => void
  onSplit: () => void
  onAddMedia: (path: string) => void
  /** The project's own path, to leave it out of the media list. */
  projectPath: string
}

/** Play, step, jump, split, and add media, under the program monitor. */
export function FilmTransport({ film, playing, onPlay, muted, onMute, onSeek, onStep, onSplit, onAddMedia, projectPath }: FilmTransportProps) {
  const { t } = useTranslation('workspace')
  const button = 'size-8'
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border bg-background px-3" data-testid="film-transport">
      <FilmMediaMenu projectPath={projectPath} onAdd={onAddMedia} />
      <div className="flex-1" />
      <Button variant="ghost" size="icon" className={button} aria-label={t('filmKit.goToStart')} title={t('filmKit.goToStart')} onClick={() => onSeek(0)}>
        <SkipBack className="size-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('filmKit.stepBack')} title={t('filmKit.stepBack')} onClick={() => onStep(-1)}>
        <StepBack className="size-4" aria-hidden="true" />
      </Button>
      <Button size="icon" className="size-9" aria-label={playing ? t('filmKit.pause') : t('filmKit.play')} title={`${playing ? t('filmKit.pause') : t('filmKit.play')} (Space)`} onClick={onPlay} data-testid="film-play">
        {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('filmKit.stepForward')} title={t('filmKit.stepForward')} onClick={() => onStep(1)}>
        <StepForward className="size-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t('filmKit.goToEnd')} title={t('filmKit.goToEnd')} onClick={() => onSeek(Math.max(0, film.duration - film.frame))}>
        <SkipForward className="size-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label={muted ? t('filmKit.unmute') : t('filmKit.mute')} title={muted ? t('filmKit.unmute') : t('filmKit.mute')} aria-pressed={muted} onClick={onMute} data-testid="film-mute">
        {muted ? <VolumeX className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
      </Button>
      <span className="ml-2 font-mono text-[13px] tabular-nums text-foreground" data-testid="film-timecode">{timecode(film.playhead, film.fps)}</span>
      <span className="font-mono text-[13px] tabular-nums text-muted-foreground">/ {timecode(film.duration, film.fps)}</span>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" onClick={onSplit} title={`${t('filmKit.split')} (⌘K)`} data-testid="film-split">
        <Scissors className="size-3.5" aria-hidden="true" />
        {t('filmKit.split')}
      </Button>
    </div>
  )
}
