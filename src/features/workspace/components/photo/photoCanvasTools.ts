import { HAND_TOOL, ZOOM_TOOL, dragRect, type KitPointer, type KitTool, type RasterRect } from '@/features/kits/public'

/** An image area that needs no repaint: the change touched no pixels (selections). */
const NO_REPAINT: RasterRect = { x0: 0, y0: 0, x1: 0, y1: 0 }

const SOFT_EDGE = 2
const ANT_DASH = [4, 4]

/** What Photo's tools need from the editor. */
export type PhotoToolEnv = {
  brushSize: number
  foreground: string
  background: string
  shapeKind: 'rect' | 'ellipse'
  /** The active layer's bounds, for the Move preview and its repaint. */
  layerBounds: RasterRect | null
  run: (command: string, params: Record<string, unknown>, damage?: RasterRect | null) => Promise<boolean>
  pick: (rgb: [number, number, number]) => void
  /** The Crop tool proposes an area; the editor confirms it (Enter) or drops it (Escape). */
  proposeCrop: (area: { x: number; y: number; width: number; height: number }) => void
  /** The Type tool asks for text at a document point. */
  beginText: (pointer: KitPointer) => void
  /** The Clone Stamp's source, set with Alt-click; null until then. */
  cloneSource: { x: number; y: number } | null
  setCloneSource: (source: { x: number; y: number } | null) => void
}

/** The engine command behind each brush-like tool. */
const PAINT_COMMANDS: Record<string, string> = {
  Brush: 'paint.stroke',
  Eraser: 'paint.stroke',
  SpotHealing: 'paint.spotHealing',
  CloneStamp: 'paint.cloneStamp',
  HistoryBrush: 'paint.historyBrush',
  Blur: 'paint.blur',
  Dodge: 'paint.dodge',
}

/** Brush-like tools with their own colour show their reach in this tint while painting. */
const REACH_TINT = 'rgba(86, 69, 212, 0.35)'

function selectionMode(pointer: KitPointer) {
  if (pointer.shift && pointer.alt) return 'intersect'
  if (pointer.shift) return 'add'
  if (pointer.alt) return 'subtract'
  return 'replace'
}

function rectArea(area: { x: number; y: number; width: number; height: number }, margin = 0): RasterRect {
  return { x0: area.x - margin, y0: area.y - margin, x1: area.x + area.width + margin, y1: area.y + area.height + margin }
}

function strokeArea(points: readonly number[][], size: number): RasterRect {
  const reach = size / 2 + SOFT_EDGE
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return {
    x0: Math.floor(Math.min(...xs) - reach),
    y0: Math.floor(Math.min(...ys) - reach),
    x1: Math.ceil(Math.max(...xs) + reach),
    y1: Math.ceil(Math.max(...ys) + reach),
  }
}

function dashed(context: CanvasRenderingContext2D) {
  context.lineWidth = 1
  context.strokeStyle = '#ffffff'
  context.setLineDash([])
  context.stroke()
  context.strokeStyle = '#111111'
  context.setLineDash(ANT_DASH)
  context.stroke()
}

/** The parameters a brush-like tool adds to its stroke, or null when the press is not a stroke. */
function paintParams(id: string, env: PhotoToolEnv, start: KitPointer): Record<string, unknown> | null {
  if (id === 'Brush') return { color: env.foreground }
  if (id === 'Eraser') return { color: env.foreground, erase: true }
  if (id !== 'CloneStamp') return {}
  if (start.alt) {
    env.setCloneSource({ x: start.x, y: start.y })
    return null
  }
  if (!env.cloneSource) return null
  // Aligned: the source keeps its offset from the brush across strokes.
  return { offset: [Math.round(env.cloneSource.x - start.x), Math.round(env.cloneSource.y - start.y)] }
}

function paintTool(id: string, env: PhotoToolEnv): KitTool {
  const command = PAINT_COMMANDS[id]
  const erase = id === 'Eraser'
  return {
    id,
    cursor: 'crosshair',
    begin: (start, { overlay, viewport }) => {
      const params = paintParams(id, env, start)
      if (!params) return
      const points: number[][] = [[start.x, start.y, start.pressure]]
      let last = start
      const segment = (to: KitPointer) => overlay.add((context, toScreen) => {
        const from = toScreen(last.x, last.y)
        const next = toScreen(to.x, to.y)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.lineWidth = Math.max(1, env.brushSize * viewport.view.zoom)
        context.strokeStyle = id === 'Brush' ? env.foreground : erase ? '#f3f3f6' : REACH_TINT
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(next.x, next.y)
        context.stroke()
      })
      segment(start)
      return {
        move: (pointer) => {
          points.push([pointer.x, pointer.y, pointer.pressure])
          segment(pointer)
          last = pointer
        },
        end: () => void env.run(command, { points, size: env.brushSize, ...params }, strokeArea(points, env.brushSize)),
      }
    },
  }
}

/** A drag that previews a rectangle and hands the final area to `done`. */
function rectTool(id: string, cursor: string, done: (area: { x: number; y: number; width: number; height: number }, start: KitPointer, end: KitPointer) => void, shape?: () => 'rect' | 'ellipse', fill?: () => string): KitTool {
  return {
    id,
    cursor,
    begin: (start, { overlay }) => {
      let area = dragRect(start, start)
      return {
        move: (pointer) => {
          area = dragRect(start, pointer, pointer.shift && Boolean(shape))
          overlay.draw((context, toScreen) => {
            const a = toScreen(area.x, area.y)
            const b = toScreen(area.x + area.width, area.y + area.height)
            context.beginPath()
            if (shape?.() === 'ellipse') context.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
            else context.rect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y)
            if (fill) {
              context.globalAlpha = 0.6
              context.fillStyle = fill()
              context.fill()
              context.globalAlpha = 1
            }
            dashed(context)
          })
        },
        end: (pointer) => done(area, start, pointer),
      }
    },
  }
}

function lassoTool(env: PhotoToolEnv): KitTool {
  return {
    id: 'Lasso',
    cursor: 'crosshair',
    begin: (start, { overlay }) => {
      const points: number[][] = [[Math.round(start.x), Math.round(start.y)]]
      return {
        move: (pointer) => {
          points.push([Math.round(pointer.x), Math.round(pointer.y)])
          overlay.draw((context, toScreen) => {
            context.beginPath()
            points.forEach(([x, y], index) => {
              const p = toScreen(x, y)
              if (index === 0) context.moveTo(p.x, p.y)
              else context.lineTo(p.x, p.y)
            })
            dashed(context)
          })
        },
        end: () => {
          if (points.length < 3) void env.run('select.deselect', {}, NO_REPAINT)
          else void env.run('select.lasso', { points, mode: selectionMode(start) }, NO_REPAINT)
        },
      }
    },
  }
}

function moveTool(env: PhotoToolEnv): KitTool {
  return {
    id: 'Move',
    cursor: 'move',
    begin: (start, { overlay }) => {
      const bounds = env.layerBounds
      let delta = { x: 0, y: 0 }
      return {
        move: (pointer) => {
          delta = { x: Math.round(pointer.x - start.x), y: Math.round(pointer.y - start.y) }
          if (!bounds) return
          overlay.draw((context, toScreen) => {
            const a = toScreen(bounds.x0 + delta.x, bounds.y0 + delta.y)
            const b = toScreen(bounds.x1 + delta.x, bounds.y1 + delta.y)
            context.beginPath()
            context.rect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y)
            dashed(context)
          })
        },
        end: () => {
          if (!delta.x && !delta.y) return
          const damage = bounds ? {
            x0: Math.min(bounds.x0, bounds.x0 + delta.x),
            y0: Math.min(bounds.y0, bounds.y0 + delta.y),
            x1: Math.max(bounds.x1, bounds.x1 + delta.x),
            y1: Math.max(bounds.y1, bounds.y1 + delta.y),
          } : null
          void env.run('layer.translate', { dx: delta.x, dy: delta.y }, damage)
        },
      }
    },
  }
}

function gradientTool(env: PhotoToolEnv): KitTool {
  return {
    id: 'Gradient',
    cursor: 'crosshair',
    begin: (start, { overlay }) => {
      let end = start
      return {
        move: (pointer) => {
          end = pointer
          overlay.draw((context, toScreen) => {
            const a = toScreen(start.x, start.y)
            const b = toScreen(end.x, end.y)
            context.beginPath()
            context.moveTo(a.x, a.y)
            context.lineTo(b.x, b.y)
            dashed(context)
          })
        },
        end: () => {
          if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return
          void env.run('paint.gradient', { from: [start.x, start.y], to: [end.x, end.y], colors: [env.foreground, env.background] })
        },
      }
    },
  }
}

/** The tools Photo's in-page canvas handles, by Photo tool id. */
export function photoCanvasTool(id: string, env: PhotoToolEnv): KitTool {
  switch (id) {
    case 'Brush':
    case 'Eraser':
    case 'SpotHealing':
    case 'CloneStamp':
    case 'HistoryBrush':
    case 'Blur':
    case 'Dodge':
      return paintTool(id, env)
    case 'MagicWand':
      return {
        id,
        cursor: 'crosshair',
        begin: (pointer) => void env.run('select.magicWand', { x: Math.floor(pointer.x), y: Math.floor(pointer.y), mode: selectionMode(pointer) }, NO_REPAINT),
      }
    case 'Eyedropper':
      return {
        id,
        cursor: 'crosshair',
        begin: (pointer, { viewport }) => {
          const rgb = viewport.sample(pointer.clientX, pointer.clientY)
          if (rgb) env.pick(rgb)
        },
      }
    case 'RectMarquee':
      return rectTool(id, 'crosshair', (area, start) => {
        if (area.width < 1 || area.height < 1) void env.run('select.deselect', {}, NO_REPAINT)
        else void env.run('select.rect', { ...area, mode: selectionMode(start) }, NO_REPAINT)
      })
    case 'Lasso':
      return lassoTool(env)
    case 'Move':
      return moveTool(env)
    case 'PaintBucket':
      return {
        id,
        cursor: 'crosshair',
        begin: (pointer) => void env.run('paint.bucket', { x: Math.floor(pointer.x), y: Math.floor(pointer.y), color: env.foreground }),
      }
    case 'Gradient':
      return gradientTool(env)
    case 'Crop':
      return rectTool(id, 'crosshair', (area) => {
        if (area.width >= 1 && area.height >= 1) env.proposeCrop(area)
      })
    case 'Rectangle':
      return rectTool(id, 'crosshair', (area) => {
        if (area.width < 1 || area.height < 1) return
        void env.run('shape.create', { kind: env.shapeKind, rect: [area.x, area.y, area.width, area.height], fill: env.foreground }, rectArea(area, SOFT_EDGE))
      }, () => env.shapeKind, () => env.foreground)
    case 'Type':
      return {
        id,
        cursor: 'text',
        begin: (pointer) => env.beginText(pointer),
      }
    case 'Zoom':
      return ZOOM_TOOL
    default:
      return HAND_TOOL
  }
}

/** Marching ants for selection segments `[ax, ay, bx, by, …]` in document pixels. */
export function drawSelectionAnts(segments: Int32Array, context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }) {
  context.beginPath()
  for (let index = 0; index + 3 < segments.length; index += 4) {
    const a = toScreen(segments[index], segments[index + 1])
    const b = toScreen(segments[index + 2], segments[index + 3])
    context.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5)
    context.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5)
  }
  context.lineWidth = 1
  context.strokeStyle = '#ffffff'
  context.stroke()
  context.strokeStyle = '#111111'
  context.setLineDash(ANT_DASH)
  context.lineDashOffset = -((Date.now() / 80) % 8)
  context.stroke()
}

/** The proposed crop: the rest of the image dimmed, the kept area outlined. */
export function drawCropProposal(area: { x: number; y: number; width: number; height: number }, context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, documentSize: { width: number; height: number }) {
  const a = toScreen(area.x, area.y)
  const b = toScreen(area.x + area.width, area.y + area.height)
  const d0 = toScreen(0, 0)
  const d1 = toScreen(documentSize.width, documentSize.height)
  context.fillStyle = 'rgba(15, 15, 30, 0.45)'
  context.beginPath()
  context.rect(d0.x, d0.y, d1.x - d0.x, d1.y - d0.y)
  context.rect(a.x, a.y, b.x - a.x, b.y - a.y)
  context.fill('evenodd')
  context.strokeStyle = '#ffffff'
  context.lineWidth = 1
  context.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y)
}
