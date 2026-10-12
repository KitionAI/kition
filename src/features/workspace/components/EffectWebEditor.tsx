import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'
import { notify } from '@/lib/notify'
import { requestShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import { splitWorkspacePath, unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
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
} from '@/features/kits/public'
import { EffectPropertiesPanel } from './effect/EffectPropertiesPanel'
import { EffectTimeline } from './effect/EffectTimeline'
import { EffectTransport } from './effect/EffectTransport'
import { EFFECT_SDK, describeEffect } from './effect/effectKitSdk'

/** Effect's menus, in After Effects' order. */
const EFFECT_MENU_ORDER = ['File', 'Edit', 'Composition', 'Layer', 'Effect', 'Animation', 'View', 'Window', 'Help']

type EffectWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

/**
 * Plays the composition from the current time against the wall clock; frames
 * the engine cannot render in time are skipped, as a preview does.
 */
function usePlayback(run: (command: string, params: Record<string, unknown>) => Promise<unknown>, time: number, duration: number) {
  const [playing, setPlaying] = useState(false)
  const latest = useRef({ time, duration })
  latest.current = { time, duration }
  const origin = useRef<{ wall: number; time: number } | null>(null)

  const stop = useCallback(() => {
    origin.current = null
    setPlaying(false)
  }, [])

  const toggle = useCallback(() => {
    if (playing) {
      stop()
      return
    }
    const from = latest.current.time >= latest.current.duration - 1e-3 ? 0 : latest.current.time
    origin.current = { wall: performance.now(), time: from }
    setPlaying(true)
  }, [playing, stop])

  useEffect(() => {
    if (!playing) return undefined
    let stopped = false
    let busy = false
    const step = async () => {
      if (stopped || !origin.current) return
      const at = origin.current.time + (performance.now() - origin.current.wall) / 1000
      if (at >= latest.current.duration) {
        stop()
        return
      }
      if (!busy) {
        busy = true
        await run('time.set', { time: at }).catch(stop)
        busy = false
      }
      requestAnimationFrame(() => void step())
    }
    void step()
    return () => {
      stopped = true
    }
  }, [playing, run, stop])

  return { playing, toggle, stop }
}

/** Renders the composition as an H.264 MP4 beside the project, under an unused name. */
function useMovieRender(doc: KitEngine | null, path: string) {
  const { t } = useTranslation('workspace')
  const [rendering, setRendering] = useState(false)
  const start = useCallback(async () => {
    if (!doc || rendering) return
    setRendering(true)
    try {
      const { folder, stem } = splitWorkspacePath(path)
      const target = await unusedWorkspacePath(folder, stem, 'mp4')
      const bytes = await doc.invoke<Uint8Array>('renderMovie', splitWorkspacePath(target).name, 'h264')
      await KITION_KIT_HOST.write(target, bytes)
      notify.success(t('effectKit.rendered', { name: splitWorkspacePath(target).name }))
      requestShowWorkspaceFile(target)
    } catch (error) {
      notify.error(t('effectKit.renderFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setRendering(false)
    }
  }, [doc, path, rendering, t])
  return { rendering, start }
}

/**
 * A motion-graphics project edited in the page, on the Kit SDK template: the
 * Effect engine runs in a worker and paints the composition viewer, footage is
 * lent from the workspace, and Kition draws the transport, the layer timeline,
 * and the Transform properties.
 */
export function EffectWebEditor({ path, active, onOpenAgent }: EffectWebEditorProps) {
  const { t } = useTranslation('workspace')
  const effect = useKitDocument(KITION_KIT_HOST, EFFECT_SDK, path, active, describeEffect)
  const editor = useKitEditor(effect, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const state = effect.state
  const { run: runQuietly } = effect
  const { run } = editor
  const playback = usePlayback(runQuietly, state?.time ?? 0, state?.comp?.duration ?? 0)
  const movie = useMovieRender(effect.doc, path)

  const seek = useCallback((seconds: number) => void runQuietly('time.set', { time: Math.max(0, seconds) }).catch(() => undefined), [runQuietly])
  const step = (frames: number) => void runQuietly('time.step', { frames }).catch(() => undefined)

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!state) return
    const command = event.metaKey || event.ctrlKey
    if (event.key === ' ' && !command) playback.toggle()
    else if (event.key === 'PageDown' || (event.key === 'ArrowRight' && command)) step(event.shiftKey ? 10 : 1)
    else if (event.key === 'PageUp' || (event.key === 'ArrowLeft' && command)) step(event.shiftKey ? -10 : -1)
    else if (event.key === 'Home') seek(0)
    else if (event.key === 'End') seek((state.comp?.duration ?? 0) - state.frame)
    else if (command && event.key === '0') canvas.current?.fit()
    else return
    event.preventDefault()
  }

  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <KitEditorFrame
      document={effect}
      editor={editor}
      title={filename}
      icon={Sparkles}
      menuOrder={EFFECT_MENU_ORDER}
      menuLabel={(label) => t(`effectKit.menu.${label}`, { defaultValue: label })}
      onKeyDown={keyDown}
      actions={(
        <Button variant="ghost" size="sm" disabled={!state?.comp || movie.rendering} onClick={() => void movie.start()} data-testid="effect-render">
          {movie.rendering ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
          {movie.rendering ? t('effectKit.rendering') : t('effectKit.renderMovie')}
        </Button>
      )}
      side={<EffectPropertiesPanel effect={state} onRun={(command, params) => void run(command, params)} />}
      bottom={state ? (
        <>
          <EffectTransport
            effect={state}
            playing={playback.playing}
            onPlay={playback.toggle}
            onSeek={seek}
            onStep={step}
            onNewLayer={(command, params) => void run(command, params)}
          />
          <EffectTimeline
            effect={state}
            onSeek={(seconds) => {
              playback.stop()
              seek(seconds)
            }}
            onSelect={(layer, add) => void run('layer.select', { layers: [layer], add })}
          />
        </>
      ) : null}
      status={(
        <span data-testid="effect-status">
          {state?.comp ? t('effectKit.summary', { name: state.comp.name, width: state.comp.width, height: state.comp.height, fps: Math.round(state.comp.fps * 100) / 100, layers: state.layers.length }) : t('effectKit.noComp')}
        </span>
      )}
      statusEnd={zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
    >
      {effect.doc && state?.comp ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={effect.doc}
          change={effect.change}
          tool={HAND_TOOL}
          spacePans={false}
          onView={(view) => setZoom(view.zoom)}
        />
      ) : null}
    </KitEditorFrame>
  )
}
