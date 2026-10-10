import type { PhotoSdkDocument } from './photoSdk'

/** The largest image the engine renders for one frame; bigger views are drawn scaled up. */
const MAX_FRAME_PIXELS = 4_000_000
const FIT_MARGIN = 32
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64
const CHECKER = 8

/** The view: `zoom` screen pixels per image pixel, with image point (`x`, `y`) at the top-left. */
export type PhotoView = { zoom: number; x: number; y: number }

type Frame = { bitmap: HTMLCanvasElement; x: number; y: number; width: number; height: number }

export type PhotoViewportStats = { renderMs: number; frameWidth: number; frameHeight: number }

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

function checkerPattern(context: CanvasRenderingContext2D) {
  const tile = document.createElement('canvas')
  tile.width = CHECKER * 2
  tile.height = CHECKER * 2
  const tileContext = tile.getContext('2d')
  if (!tileContext) return null
  tileContext.fillStyle = '#ffffff'
  tileContext.fillRect(0, 0, CHECKER * 2, CHECKER * 2)
  tileContext.fillStyle = '#e8e8ec'
  tileContext.fillRect(0, 0, CHECKER, CHECKER)
  tileContext.fillRect(CHECKER, CHECKER, CHECKER, CHECKER)
  return context.createPattern(tile, 'repeat')
}

/**
 * Paints an engine document into a `<canvas>`. The engine renders only the
 * visible part of the image at the current zoom into a cached frame; panning
 * and zooming redraw that frame at once, and a fresh render follows when the
 * view settles.
 */
export class PhotoViewport {
  view: PhotoView = { zoom: 1, x: 0, y: 0 }
  private frame: Frame | null = null
  private pattern: CanvasPattern | null = null
  private settle: number | undefined

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly doc: PhotoSdkDocument,
    private readonly backdrop: string,
    private readonly onChange: (view: PhotoView, stats: PhotoViewportStats | null) => void,
  ) {}

  dispose() {
    window.clearTimeout(this.settle)
    this.frame = null
  }

  private get size() {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight, dpr: window.devicePixelRatio || 1 }
  }

  /** Image coordinates of a point in the canvas's CSS pixels. */
  toImage(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: this.view.x + (clientX - rect.left) / this.view.zoom, y: this.view.y + (clientY - rect.top) / this.view.zoom }
  }

  fit() {
    const { width, height } = this.size
    if (!width || !height) return
    const zoom = clampZoom(Math.min((width - FIT_MARGIN * 2) / this.doc.width, (height - FIT_MARGIN * 2) / this.doc.height))
    this.setView({ zoom, x: this.doc.width / 2 - width / 2 / zoom, y: this.doc.height / 2 - height / 2 / zoom })
  }

  /** Zooms to `zoom`, keeping the image point under (`clientX`, `clientY`) still; the centre by default. */
  zoomTo(zoom: number, clientX?: number, clientY?: number) {
    const rect = this.canvas.getBoundingClientRect()
    const anchorX = clientX ?? rect.left + rect.width / 2
    const anchorY = clientY ?? rect.top + rect.height / 2
    const point = this.toImage(anchorX, anchorY)
    const next = clampZoom(zoom)
    this.setView({ zoom: next, x: point.x - (anchorX - rect.left) / next, y: point.y - (anchorY - rect.top) / next })
  }

  panBy(dx: number, dy: number) {
    this.setView({ ...this.view, x: this.view.x - dx / this.view.zoom, y: this.view.y - dy / this.view.zoom })
  }

  private setView(view: PhotoView) {
    this.view = view
    this.draw()
    this.onChange(view, null)
    window.clearTimeout(this.settle)
    this.settle = window.setTimeout(() => this.render(), 120)
  }

  /** Renders the visible part of the image now; call after the document changes. */
  render() {
    window.clearTimeout(this.settle)
    const { width, height, dpr } = this.size
    if (!width || !height) return
    const x0 = Math.max(0, Math.floor(this.view.x))
    const y0 = Math.max(0, Math.floor(this.view.y))
    const x1 = Math.min(this.doc.width, Math.ceil(this.view.x + width / this.view.zoom))
    const y1 = Math.min(this.doc.height, Math.ceil(this.view.y + height / this.view.zoom))
    if (x1 <= x0 || y1 <= y0) {
      this.frame = null
      this.draw()
      return
    }
    let scale = this.view.zoom * dpr
    const pixels = (x1 - x0) * (y1 - y0) * scale * scale
    if (pixels > MAX_FRAME_PIXELS) scale *= Math.sqrt(MAX_FRAME_PIXELS / pixels)
    const frameWidth = Math.max(1, Math.ceil((x1 - x0) * scale))
    const frameHeight = Math.max(1, Math.ceil((y1 - y0) * scale))
    const started = performance.now()
    const rgba = this.doc.render(x0, y0, scale, frameWidth, frameHeight)
    const bitmap = this.frame?.bitmap ?? document.createElement('canvas')
    bitmap.width = frameWidth
    bitmap.height = frameHeight
    bitmap.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), frameWidth, frameHeight), 0, 0)
    this.frame = { bitmap, x: x0, y: y0, width: frameWidth / scale, height: frameHeight / scale }
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    this.onChange(this.view, { renderMs, frameWidth, frameHeight })
  }

  /** Redraws the cached frame at the current view. */
  draw() {
    const { width, height, dpr } = this.size
    const backingWidth = Math.round(width * dpr)
    const backingHeight = Math.round(height * dpr)
    if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
      this.canvas.width = backingWidth
      this.canvas.height = backingHeight
    }
    const context = this.canvas.getContext('2d')
    if (!context) return
    const { zoom, x, y } = this.view
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = this.backdrop
    context.fillRect(0, 0, width, height)
    const left = -x * zoom
    const top = -y * zoom
    const docWidth = this.doc.width * zoom
    const docHeight = this.doc.height * zoom
    context.shadowColor = 'rgba(15, 15, 30, 0.12)'
    context.shadowBlur = 12
    this.pattern ??= checkerPattern(context)
    context.fillStyle = this.pattern ?? '#ffffff'
    context.fillRect(left, top, docWidth, docHeight)
    context.shadowBlur = 0
    const frame = this.frame
    if (frame) {
      context.imageSmoothingEnabled = zoom < 1
      context.imageSmoothingQuality = 'high'
      context.drawImage(frame.bitmap, (frame.x - x) * zoom, (frame.y - y) * zoom, frame.width * zoom, frame.height * zoom)
    }
  }

  /** The colour of the image pixel under a canvas point, from the cached frame. */
  sample(clientX: number, clientY: number): [number, number, number] | null {
    const frame = this.frame
    if (!frame) return null
    const point = this.toImage(clientX, clientY)
    const fx = Math.floor(((point.x - frame.x) / frame.width) * frame.bitmap.width)
    const fy = Math.floor(((point.y - frame.y) / frame.height) * frame.bitmap.height)
    if (fx < 0 || fy < 0 || fx >= frame.bitmap.width || fy >= frame.bitmap.height) return null
    const data = frame.bitmap.getContext('2d')?.getImageData(fx, fy, 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  }
}
