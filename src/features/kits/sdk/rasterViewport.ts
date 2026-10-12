/** What the viewport needs from an engine: the document size and two render calls. */
export type RasterSource = {
  readonly width: number
  readonly height: number
  render(x: number, y: number, scale: number, width: number, height: number): Promise<Uint8Array>
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Promise<Uint8Array>
}

/** The largest image the engine renders for one frame; bigger views are drawn scaled up. */
const MAX_FRAME_PIXELS = 8_000_000
const FIT_MARGIN = 32
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64
const CHECKER = 8

/** The view: `zoom` screen pixels per image pixel, with image point (`x`, `y`) at the top-left. */
export type RasterView = { zoom: number; x: number; y: number }

/**
 * The cached render: `bitmap` shows the image area at (`x`, `y`), `width` × `height` image
 * pixels, at `scale`. Below 1:1 the scale is 1/k, so each bitmap pixel is exactly a k × k block.
 */
type Frame = { bitmap: HTMLCanvasElement; x: number; y: number; width: number; height: number; scale: number }

/** An image area in image pixels. */
export type RasterRect = { x0: number; y0: number; x1: number; y1: number }

export type RasterViewportStats = { renderMs: number; frameWidth: number; frameHeight: number }

function imageData(rgba: Uint8Array, width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

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
 * Paints a kit document into a `<canvas>`. The engine renders only the
 * visible part of the image at the current zoom into a cached frame; panning
 * and zooming redraw that frame at once, and a fresh render follows when the
 * view settles.
 */
/** Draws on top of the document in canvas CSS pixels; `toScreen` maps document points there. */
export type RasterDecoration = (context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, view: RasterView) => void

export class RasterViewport {
  view: RasterView = { zoom: 1, x: 0, y: 0 }
  /** Drawn after the document on every frame, for example marching ants. */
  decorate: RasterDecoration | null = null
  private frame: Frame | null = null
  private pattern: CanvasPattern | null = null
  private settle: number | undefined
  private rendering = false
  private renderAgain = false
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly doc: RasterSource,
    private readonly backdrop: string,
    private readonly onChange: (view: RasterView, stats: RasterViewportStats | null) => void,
  ) {}

  dispose() {
    window.clearTimeout(this.settle)
    this.disposed = true
    this.frame = null
  }

  private get size() {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight, dpr: window.devicePixelRatio || 1 }
  }

  /** Canvas CSS pixel position of a document point. */
  toScreen(x: number, y: number) {
    return { x: (x - this.view.x) * this.view.zoom, y: (y - this.view.y) * this.view.zoom }
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

  /** Fits `area` (document pixels) in the canvas, centred: a page or spread brought into view. */
  fitArea(area: RasterRect) {
    const { width, height } = this.size
    const w = area.x1 - area.x0
    const h = area.y1 - area.y0
    if (!width || !height || w <= 0 || h <= 0) return
    const zoom = clampZoom(Math.min((width - FIT_MARGIN * 2) / w, (height - FIT_MARGIN * 2) / h))
    this.setView({ zoom, x: area.x0 + w / 2 - width / 2 / zoom, y: area.y0 + h / 2 - height / 2 / zoom })
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

  private setView(view: RasterView) {
    this.view = view
    this.draw()
    this.onChange(view, null)
    window.clearTimeout(this.settle)
    this.settle = window.setTimeout(() => void this.render(), 120)
  }

  /**
   * Renders the visible part of the image in the engine, then shows it; call after the
   * document changes. One render runs at a time; a request meanwhile renders again after it.
   */
  async render() {
    window.clearTimeout(this.settle)
    if (this.rendering) {
      this.renderAgain = true
      return
    }
    this.rendering = true
    try {
      await this.renderNow()
    } catch {
      // A closed or stopped engine; the editor reports that itself.
    } finally {
      this.rendering = false
    }
    if (this.renderAgain && !this.disposed) {
      this.renderAgain = false
      await this.render()
    }
  }

  private async renderNow() {
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
    const wanted = this.view.zoom * dpr
    const started = performance.now()
    let frame: Omit<Frame, 'bitmap'>
    let rgba: Uint8Array
    let frameWidth: number
    let frameHeight: number
    if (wanted < 1) {
      // A whole-number reduction at least as sharp as the screen, so patches line up exactly.
      let k = Math.max(1, Math.floor(1 / wanted))
      while (((x1 - x0) / k) * ((y1 - y0) / k) > MAX_FRAME_PIXELS) k += 1
      frameWidth = Math.ceil((x1 - x0) / k)
      frameHeight = Math.ceil((y1 - y0) / k)
      rgba = await this.doc.renderArea(x0, y0, x0 + frameWidth * k, y0 + frameHeight * k, frameWidth, frameHeight)
      frame = { x: x0, y: y0, width: frameWidth * k, height: frameHeight * k, scale: 1 / k }
    } else {
      let scale = wanted
      const pixels = (x1 - x0) * (y1 - y0) * scale * scale
      if (pixels > MAX_FRAME_PIXELS) scale = Math.max(1, scale * Math.sqrt(MAX_FRAME_PIXELS / pixels))
      frameWidth = Math.max(1, Math.ceil((x1 - x0) * scale))
      frameHeight = Math.max(1, Math.ceil((y1 - y0) * scale))
      rgba = await this.doc.render(x0, y0, scale, frameWidth, frameHeight)
      frame = { x: x0, y: y0, width: frameWidth / scale, height: frameHeight / scale, scale }
    }
    if (this.disposed) return
    const bitmap = document.createElement('canvas')
    bitmap.width = frameWidth
    bitmap.height = frameHeight
    bitmap.getContext('2d')?.putImageData(imageData(rgba, frameWidth, frameHeight), 0, 0)
    this.frame = { bitmap, ...frame }
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    this.onChange(this.view, { renderMs, frameWidth, frameHeight })
  }

  /**
   * Re-renders only `area` (what a stroke touched) into the cached frame, at the frame's
   * own scale, then redraws. When the frame changed meanwhile, renders it all again.
   */
  async renderArea(area: RasterRect) {
    const frame = this.frame
    if (!frame || this.rendering) {
      await this.render()
      return
    }
    const sx = frame.bitmap.width / frame.width
    const sy = frame.bitmap.height / frame.height
    const px0 = clamp(Math.floor((area.x0 - frame.x) * sx), 0, frame.bitmap.width)
    const py0 = clamp(Math.floor((area.y0 - frame.y) * sy), 0, frame.bitmap.height)
    const px1 = clamp(Math.ceil((area.x1 - frame.x) * sx), 0, frame.bitmap.width)
    const py1 = clamp(Math.ceil((area.y1 - frame.y) * sy), 0, frame.bitmap.height)
    if (px1 <= px0 || py1 <= py0) return
    const width = px1 - px0
    const height = py1 - py0
    const started = performance.now()
    const k = Math.round(1 / frame.scale)
    let rgba: Uint8Array
    try {
      rgba = frame.scale < 1
        ? await this.doc.renderArea(frame.x + px0 * k, frame.y + py0 * k, frame.x + px1 * k, frame.y + py1 * k, width, height)
        : await this.doc.render(frame.x + px0 / sx, frame.y + py0 / sy, frame.scale, width, height)
    } catch {
      return
    }
    if (this.disposed) return
    if (this.frame !== frame) {
      await this.render()
      return
    }
    frame.bitmap.getContext('2d')?.putImageData(imageData(rgba, width, height), px0, py0)
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    this.onChange(this.view, { renderMs, frameWidth: width, frameHeight: height })
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
    if (this.decorate) {
      context.save()
      this.decorate(context, (px, py) => this.toScreen(px, py), this.view)
      context.restore()
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
