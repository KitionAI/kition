import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KitToolMethod } from './kitEngine'
import type { KitPointer, KitTool } from './kitTools'
import type { RasterDecoration } from './rasterViewport'
import type { KitChange } from './useKitDocument'

/**
 * The engine-tools capability (Kition Kit Standard, U3a): kits whose engine
 * owns its tools' state machines (pen, direct selection, type) expose them,
 * and this one bridge runs them. The host sends pointer, key, and text events
 * in document pixels; the engine answers with requests, overlays, and a
 * cursor, and the host draws the overlays in its own style.
 */

/** One engine tool; tools sharing a `group` share a slot on the rail. */
export type EngineToolInfo = { id: string; label: string; shortcut: string | null; icon: string; group: number }

type Rgba = [number, number, number, number]

/** A drawing primitive over the canvas, in document pixels. */
type EngineToolOverlay =
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'path'; d: string; color: Rgba; width: number; dashed: boolean }
  | { kind: 'line'; ax: number; ay: number; bx: number; by: number; color: Rgba; dashed: boolean }
  | { kind: 'anchor'; x: number; y: number; color: Rgba; filled: boolean; size: number }
  | { kind: 'handle'; x: number; y: number; color: Rgba }
  | { kind: 'label'; x: number; y: number; text: string; color: Rgba }
  | { kind: 'measure'; x: number; y: number; text: string }
  | { kind: 'highlight'; quad: [number, number][]; color: Rgba }
  | { kind: 'swatch'; x: number; y: number; color: Rgba; selected: boolean }

/** Something only the host can do. */
type EngineToolRequest =
  | { kind: 'dialog'; name: string; params: unknown }
  | { kind: 'switchTool'; id: string }
  | { kind: 'status'; text: string }

export type EngineToolResponse = {
  requests: EngineToolRequest[]
  overlays: EngineToolOverlay[]
  cursor: string
  busy: boolean
  wantsText: boolean
}

type ToolCall = <R>(name: KitToolMethod, args?: unknown[], settled?: boolean) => Promise<R | null>

type EngineToolsOptions = {
  /** Tools the host runs itself (view tools), by engine id. */
  hostTools?: Record<string, KitTool>
  /** Engine tools left off the rail. */
  hidden?: ReadonlySet<string>
  /** The tool selected when the document opens. */
  initial: string
  /** A dialog the engine asks for; the editor opens it, or says it cannot. */
  onDialog?: (name: string, params: unknown) => void
}

const ACCENT = '#5645d4'
const SURFACE = '#ffffff'
const INK = '#1f1d2b'

function css([r, g, b, a]: Rgba) {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`
}

function pill(context: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  context.font = '11px ui-sans-serif, system-ui, sans-serif'
  const width = context.measureText(text).width + 12
  context.fillStyle = color
  context.beginPath()
  context.roundRect(x, y, width, 18, 4)
  context.fill()
  context.fillStyle = color === SURFACE ? INK : SURFACE
  context.textBaseline = 'middle'
  context.fillText(text, x + 6, y + 9)
}

/** Draws engine overlays over the document, in Kition's style. */
function drawEngineOverlays(overlays: readonly EngineToolOverlay[]): RasterDecoration {
  return (context, toScreen, view) => {
    for (const overlay of overlays) {
      context.save()
      context.lineWidth = 1
      context.setLineDash([])
      switch (overlay.kind) {
        case 'marquee': {
          const a = toScreen(overlay.x0, overlay.y0)
          const b = toScreen(overlay.x1, overlay.y1)
          context.fillStyle = 'rgba(86, 69, 212, 0.08)'
          context.strokeStyle = ACCENT
          context.setLineDash([4, 3])
          context.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
          context.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y)
          break
        }
        case 'path': {
          const origin = toScreen(0, 0)
          context.translate(origin.x, origin.y)
          context.scale(view.zoom, view.zoom)
          context.lineWidth = Math.max(overlay.width, 1) / view.zoom
          if (overlay.dashed) context.setLineDash([4 / view.zoom, 3 / view.zoom])
          context.strokeStyle = css(overlay.color)
          context.stroke(new Path2D(overlay.d))
          break
        }
        case 'line': {
          const a = toScreen(overlay.ax, overlay.ay)
          const b = toScreen(overlay.bx, overlay.by)
          if (overlay.dashed) context.setLineDash([4, 3])
          context.strokeStyle = css(overlay.color)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
          break
        }
        case 'anchor': {
          const p = toScreen(overlay.x, overlay.y)
          const size = overlay.size || 6
          context.fillStyle = overlay.filled ? css(overlay.color) : SURFACE
          context.strokeStyle = css(overlay.color)
          context.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size)
          context.strokeRect(Math.round(p.x - size / 2) + 0.5, Math.round(p.y - size / 2) + 0.5, size - 1, size - 1)
          break
        }
        case 'handle': {
          const p = toScreen(overlay.x, overlay.y)
          context.fillStyle = css(overlay.color)
          context.beginPath()
          context.arc(p.x, p.y, 3, 0, Math.PI * 2)
          context.fill()
          break
        }
        case 'label': {
          const p = toScreen(overlay.x, overlay.y)
          context.font = '11px ui-sans-serif, system-ui, sans-serif'
          context.fillStyle = css(overlay.color)
          context.fillText(overlay.text, p.x + 4, p.y - 4)
          break
        }
        case 'measure': {
          const p = toScreen(overlay.x, overlay.y)
          pill(context, p.x + 12, p.y + 12, overlay.text, INK)
          break
        }
        case 'highlight': {
          context.fillStyle = css(overlay.color)
          context.beginPath()
          overlay.quad.forEach(([x, y], index) => {
            const p = toScreen(x, y)
            if (index === 0) context.moveTo(p.x, p.y)
            else context.lineTo(p.x, p.y)
          })
          context.closePath()
          context.fill()
          break
        }
        case 'swatch': {
          const p = toScreen(overlay.x, overlay.y)
          context.fillStyle = css(overlay.color)
          context.strokeStyle = overlay.selected ? ACCENT : SURFACE
          context.lineWidth = 2
          context.beginPath()
          context.roundRect(p.x - 6, p.y - 6, 12, 12, 3)
          context.fill()
          context.stroke()
          break
        }
      }
      context.restore()
    }
  }
}

function mods(pointer: { shift: boolean; alt: boolean; meta: boolean }) {
  return { shift: pointer.shift, alt: pointer.alt, command: pointer.meta, control: false, space: false }
}

const EDITING_KEYS = new Set(['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'])

/**
 * Runs a kit's engine tools in a kit editor: the rail's tools from the engine,
 * the active tool as a canvas tool, its overlays as a canvas decoration, its
 * cursor, and its keys and typed text. `tool` is the document's tool call.
 */
export function useEngineTools(tool: ToolCall, ready: boolean, change: KitChange, options: EngineToolsOptions) {
  const [tools, setTools] = useState<EngineToolInfo[]>([])
  const [active, setActive] = useState(options.initial)
  const [response, setResponse] = useState<EngineToolResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const latest = useRef(options)
  latest.current = options
  const zoom = useRef(1)
  const last = useRef<{ x: number; y: number } | null>(null)

  // Events go to the engine one at a time and in order; while one is out, only the newest
  // drag or hover waits (the others are stale), so a slow engine never falls behind the pointer.
  const busy = useRef(false)
  const queue = useRef<Array<{ name: KitToolMethod; args: unknown[]; settled: boolean; coalesce: boolean }>>([])

  const answer = useCallback((next: EngineToolResponse | null) => {
    if (!next) return
    setResponse(next)
    for (const request of next.requests) {
      if (request.kind === 'switchTool') setActive(request.id)
      else if (request.kind === 'status') setStatus(request.text)
      else latest.current.onDialog?.(request.name, request.params)
    }
  }, [])

  const pump = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        answer(await tool<EngineToolResponse>(next.name, next.args, next.settled).catch(() => null))
      }
    } finally {
      busy.current = false
    }
  }, [answer, tool])

  const send = useCallback((name: KitToolMethod, args: unknown[], settled: boolean, coalesce = false) => {
    const tail = queue.current[queue.current.length - 1]
    if (coalesce && tail?.coalesce && tail.name === name) queue.current[queue.current.length - 1] = { name, args, settled, coalesce }
    else queue.current.push({ name, args, settled, coalesce })
    void pump()
  }, [pump])

  useEffect(() => {
    if (!ready) return
    void tool<EngineToolInfo[]>('tools').then((list) => setTools(list ?? []))
  }, [ready, tool])

  // The chosen tool goes to the engine (host tools stay with the host).
  useEffect(() => {
    if (!ready || latest.current.hostTools?.[active]) return
    send('selectTool', [active, zoom.current], true)
  }, [active, ready, send])

  // After any change (an undo, a menu command) the overlays follow the selection.
  useEffect(() => {
    if (!ready || latest.current.hostTools?.[active]) return
    const at = last.current ?? { x: 0, y: 0 }
    send('toolState', [at.x, at.y, '{}', zoom.current], false, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change
  }, [change.revision, ready])

  const pointer = useCallback((action: string, at: KitPointer, viewZoom: number, settled: boolean, coalesce = false) => {
    zoom.current = viewZoom
    last.current = { x: at.x, y: at.y }
    send('pointer', [JSON.stringify({ action, x: at.x, y: at.y, mods: mods(at), pressure: at.pressure, zoom: viewZoom })], settled, coalesce)
  }, [send])

  const hostTool = options.hostTools?.[active]
  const canvasTool = useMemo<KitTool>(() => hostTool ?? {
    id: active,
    cursor: response?.cursor || 'default',
    begin: (start, { viewport }) => {
      pointer('down', start, viewport.view.zoom, false)
      return {
        move: (at, context) => pointer('drag', at, context.viewport.view.zoom, false, true),
        end: (at, context) => pointer('up', at, context.viewport.view.zoom, true),
        cancel: (context) => pointer('up', start, context.viewport.view.zoom, true),
      }
    },
    hover: (at, { viewport }) => pointer('move', at, viewport.view.zoom, false, true),
    doubleClick: (at, { viewport }) => pointer('doubleClick', at, viewport.view.zoom, true),
  }, [active, hostTool, pointer, response?.cursor])

  const overlays = response?.overlays
  const decorate = useMemo(() => (overlays?.length && !hostTool ? drawEngineOverlays(overlays) : null), [hostTool, overlays])

  /**
   * Gives a key to the tool when it is mid-gesture or taking text; returns whether it did.
   * Otherwise the editor's own shortcuts get it.
   */
  const keyDown = useCallback((event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (hostTool || !response) return false
    const command = event.metaKey || event.ctrlKey
    if (response.wantsText && !command) {
      if (event.key.length === 1) send('toolText', [event.key, zoom.current], true)
      else if (EDITING_KEYS.has(event.key)) send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: false })), zoom.current], true)
      else return false
      return true
    }
    if (response.busy && EDITING_KEYS.has(event.key)) {
      send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: command })), zoom.current], true)
      return true
    }
    return false
  }, [hostTool, response, send])

  /** The tool a single-key shortcut picks: the next one of that shortcut when one is active. */
  const toolForKey = useCallback((key: string, shift: boolean) => {
    const wanted = (shift ? `Shift+${key}` : key).toLowerCase()
    const visible = tools.filter((item) => !latest.current.hidden?.has(item.id))
    const matches = visible.filter((item) => item.shortcut?.toLowerCase() === wanted)
    if (!matches.length) return null
    const index = matches.findIndex((item) => item.id === active)
    return matches[(index + 1) % matches.length].id
  }, [active, tools])

  return {
    tools,
    active,
    select: setActive,
    canvasTool,
    decorate,
    status,
    wantsText: Boolean(response?.wantsText) && !hostTool,
    keyDown,
    toolForKey,
  }
}
