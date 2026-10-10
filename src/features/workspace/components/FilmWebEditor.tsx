import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Clapperboard, Download, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { notify } from '@/lib/notify'
import { requestShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import {
  HAND_TOOL,
  KITION_KIT_HOST,
  KitCanvas,
  KitEditorFrame,
  useKitDocument,
  useKitEditor,
  type KitCanvasHandle,
  type KitEngine,
  type RasterView,
  type RasterViewportStats,
} from '@/features/kits/public'
import { FilmTimeline } from './film/FilmTimeline'
import { FilmTransport } from './film/FilmTransport'
import { FilmAudioPlayer } from './film/filmAudio'
import { FILM_SDK, describeFilm } from './film/filmKitSdk'
import { exportMovie, type ExportProgress } from './film/filmMovies'

/** Film's menus, in the order video editors show them. */
const FILM_MENU_ORDER = ['File', 'Edit', 'Clip', 'Sequence', 'Markers', 'Graphics and Titles', 'View', 'Window', 'Help']
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg)$/i

type FilmWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

/** `to` as seen from `folder`, both workspace paths: how the project names its media. */
function relativePath(folder: string, to: string) {
  const from = folder.split('/').filter(Boolean)
  const target = to.split('/').filter(Boolean)
  let shared = 0
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) shared += 1
  return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/')
}

/**
 * Plays from the playhead with sound: the audio clock leads, and the picture
 * follows it; frames the engine cannot keep up with are skipped.
 */
function usePlayback(doc: KitEngine | null, run: (command: string, params: Record<string, unknown>) => Promise<unknown>, playhead: number, duration: number) {
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const latest = useRef({ playhead, duration })
  latest.current = { playhead, duration }
  const audio = useRef<FilmAudioPlayer | null>(null)

  const stop = useCallback(() => {
    audio.current?.stop()
    audio.current = null
    setPlaying(false)
  }, [])

  // The context is made here, in the click or key press, where browsers allow sound to start.
  const toggle = useCallback(() => {
    if (playing || !doc) {
      stop()
      return
    }
    const from = latest.current.playhead >= latest.current.duration - 1e-3 ? 0 : latest.current.playhead
    const player = new FilmAudioPlayer(from, muted)
    audio.current = player
    void player.start(doc)
    setPlaying(true)
  }, [doc, muted, playing, stop])

  useEffect(() => {
    audio.current?.setMuted(muted)
  }, [muted])

  useEffect(() => {
    if (!playing) return undefined
    let busy = false
    let stopped = false
    const step = async () => {
      if (stopped) return
      const at = audio.current?.now() ?? latest.current.playhead
      if (at >= latest.current.duration) {
        stop()
        return
      }
      if (!busy) {
        busy = true
        await run('playhead.set', { seconds: at }).catch(stop)
        busy = false
      }
      requestAnimationFrame(() => void step())
    }
    void step()
    return () => {
      stopped = true
    }
  }, [playing, run, stop])

  useEffect(() => () => audio.current?.stop(), [])

  return { playing, toggle, stop, muted, toggleMuted: () => setMuted((value) => !value) }
}

/** Exports the project as an MP4 beside it, with progress and a way to stop. */
function useMovieExport(doc: KitEngine | null, path: string) {
  const { t } = useTranslation('workspace')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const abort = useRef<AbortController | null>(null)

  const start = useCallback(async () => {
    if (!doc || abort.current) return
    const controller = new AbortController()
    abort.current = controller
    setProgress({ fraction: 0, secondsLeft: null })
    try {
      const movie = await exportMovie(doc, path, setProgress, controller.signal)
      notify.success(t('filmKit.exported', { name: movie.split('/').pop() }))
      requestShowWorkspaceFile(movie)
    } catch (error) {
      if (!controller.signal.aborted) notify.error(t('filmKit.exportFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      abort.current = null
      setProgress(null)
    }
  }, [doc, path, t])

  useEffect(() => () => abort.current?.abort(), [])

  return { progress, start, cancel: () => abort.current?.abort() }
}

/**
 * A video project edited in the page, on the Kit SDK template: the Film
 * engine runs in a worker and paints the program monitor, media are lent
 * from the workspace in ranges, and Kition draws the transport and timeline.
 */
export function FilmWebEditor({ path, active, onOpenAgent }: FilmWebEditorProps) {
  const { t } = useTranslation('workspace')
  const film = useKitDocument(KITION_KIT_HOST, FILM_SDK, path, active, describeFilm)
  const editor = useKitEditor(film, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [stats, setStats] = useState<RasterViewportStats | null>(null)
  const frames = useRef<number[]>([])
  const [shownFps, setShownFps] = useState<number | null>(null)
  const state = film.state
  const { run: runQuietly } = film
  const { run } = editor
  const playback = usePlayback(film.doc, runQuietly, state?.playhead ?? 0, state?.duration ?? 0)
  const movie = useMovieExport(film.doc, path)

  const seek = useCallback((seconds: number) => void runQuietly('playhead.set', { seconds: Math.max(0, seconds) }).catch(() => undefined), [runQuietly])

  const addMedia = async (media: string) => {
    const folder = path.split('/').filter(Boolean).slice(0, -1).join('/')
    const imported = await run('file.import', { paths: [relativePath(folder, media)] })
    const item = imported ? (JSON.parse(imported) as { items?: number[] }).items?.[0] : undefined
    if (item != null) await run('timeline.place', { item, track: AUDIO.test(media) ? 'A1' : 'V1', seconds: state?.playhead ?? 0 })
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!state) return
    const command = event.metaKey || event.ctrlKey
    if (event.key === ' ' && !command) playback.toggle()
    else if (event.key === 'ArrowLeft' && !command) void runQuietly('playhead.step', { frames: event.shiftKey ? -10 : -1 })
    else if (event.key === 'ArrowRight' && !command) void runQuietly('playhead.step', { frames: event.shiftKey ? 10 : 1 })
    else if (event.key === 'Home') seek(0)
    else if (event.key === 'End') seek(state.duration - state.frame)
    else if (command && event.key === '0') canvas.current?.fit()
    else return
    event.preventDefault()
  }

  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <KitEditorFrame
      document={film}
      editor={editor}
      title={filename}
      icon={Clapperboard}
      menuOrder={FILM_MENU_ORDER}
      menuLabel={(label) => t(`filmKit.menu.${label.replace(/\W+/g, '')}`, { defaultValue: label })}
      onKeyDown={keyDown}
      actions={movie.progress ? (
        <div className="flex items-center gap-1.5" data-testid="film-exporting">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="tabular-nums text-xs text-muted-foreground">
            {t('filmKit.exporting', { percent: Math.round(movie.progress.fraction * 100) })}
          </span>
          <Button variant="ghost" size="icon" className="size-7" aria-label={t('filmKit.exportCancel')} title={t('filmKit.exportCancel')} onClick={movie.cancel}>
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" disabled={!state?.duration} onClick={() => void movie.start()} data-testid="film-export">
          <Download className="size-3.5" aria-hidden="true" />
          {t('filmKit.exportMovie')}
        </Button>
      )}
      bottom={state ? (
        <>
          <FilmTransport
            film={state}
            playing={playback.playing}
            onPlay={playback.toggle}
            muted={playback.muted}
            onMute={playback.toggleMuted}
            onSeek={seek}
            onStep={(count) => void runQuietly('playhead.step', { frames: count })}
            onSplit={() => void run('sequence.addEdit', { time: Math.round(state.playhead * state.ticksPerSecond) })}
            onAddMedia={(media) => void addMedia(media)}
            projectPath={path}
          />
          <FilmTimeline
            film={state}
            onSeek={(seconds) => {
              playback.stop()
              seek(seconds)
            }}
            onSelect={(clip, add) => void run('timeline.select', { clips: [clip], add })}
            onMove={(clip, track, seconds) => void run('timeline.move', { moves: [{ clip: clip.id, track, time: Math.round(seconds * state.ticksPerSecond) }] })}
          />
        </>
      ) : null}
      status={<span>{state?.summary ?? ''}</span>}
      statusEnd={(
        <span className="tabular-nums" data-testid="film-stats">
          {[
            film.openMs != null ? t('photoKit.stats.open', { ms: film.openMs }) : null,
            stats ? t('photoKit.stats.render', { ms: stats.renderMs }) : null,
            playback.playing && shownFps != null ? t('filmKit.playbackFps', { fps: shownFps }) : null,
          ].filter(Boolean).join(' · ')}
        </span>
      )}
    >
      {film.doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={film.doc}
          change={film.change}
          tool={HAND_TOOL}
          spacePans={false}
          onView={(_, next) => {
            if (!next) return
            setStats(next)
            const now = performance.now()
            frames.current = [...frames.current.filter((at) => now - at < 1000), now]
            setShownFps(frames.current.length)
          }}
        />
      ) : null}
    </KitEditorFrame>
  )
}
