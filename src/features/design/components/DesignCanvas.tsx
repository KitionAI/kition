import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { Bounds, DesignDocument } from '../lib/designTypes'
import type { DesignStore } from '../lib/designStore'
import {
  around,
  isNodeLocked,
  multiply,
  parentNode,
  selectionBounds,
  translation,
} from '../lib/designGeometry'
import { DesignArtwork } from './DesignArtwork'
import { DesignTextEditor } from './DesignTextEditor'
import {
  designSnapTargets,
  snapDesignMove,
  type DesignSnapTargets,
  type DesignSnapGuides,
} from '../lib/designSnapping'
type Gesture = {
  kind: 'move' | 'resize' | 'rotate' | 'marquee' | 'pan'
  x: number
  y: number
  ids: string[]
  bounds: Bounds
  handle?: string
  snapTargets?: DesignSnapTargets
  pan: { x: number; y: number }
}
export function DesignCanvas({
  document: doc,
  selection,
  store,
  images,
  active,
  editingId,
  setEditingId,
}: {
  document: DesignDocument
  selection: string[]
  store: DesignStore
  images: Record<string, string>
  active: boolean
  editingId: string | null
  setEditingId: (id: string | null) => void
}) {
  const { t } = useTranslation('design'),
    stage = useRef<HTMLDivElement>(null),
    svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 800, height: 600 }),
    [zoomOverride, setZoom] = useState<number | null>(null),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [marquee, setMarquee] = useState<Bounds | null>(null)
  const [guides, setGuides] = useState<DesignSnapGuides>({})
  const [space, setSpace] = useState(false),
    gesture = useRef<Gesture | null>(null),
    page = doc.pages[0]
  const fit = Math.max(
      0.02,
      Math.min(
        (size.width - 96) / page.width,
        (size.height - 100) / page.height,
        1,
      ),
    ),
    zoom = zoomOverride ?? fit
  const center = {
    x: (size.width - page.width * zoom) / 2 + pan.x,
    y: (size.height - page.height * zoom) / 2 + pan.y,
  }
  const live = useRef({ zoom })
  live.current = { zoom }
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ width: r.width, height: r.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active) {
      gesture.current = null
      store.cancel()
      setSpace(false)
      setMarquee(null)
      setGuides({})
      setEditingId(null)
      return
    }
    const el = stage.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('textarea'))
        return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey)
        setZoom(
          Math.max(
            0.02,
            Math.min(4, live.current.zoom * Math.exp(-event.deltaY * 0.002)),
          ),
        )
      else setPan((p) => ({ x: p.x - event.deltaX, y: p.y - event.deltaY }))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [active, setEditingId, store])
  function position(event: ReactPointerEvent) {
    const rect = svg.current!.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) / zoom,
      y: (event.clientY - rect.top) / zoom,
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !active ||
      editingId ||
      (event.target as Element).closest('button,textarea')
    )
      return
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target as Element,
      p = position(event)
    event.preventDefault()
    stage.current?.focus()
    target.setPointerCapture(event.pointerId)
    const handle = target.getAttribute('data-design-handle')
    if (event.button === 1 || space) {
      gesture.current = {
        kind: 'pan',
        x: event.clientX,
        y: event.clientY,
        ids: [],
        bounds: selectionBounds(doc, []),
        pan,
      }
      return
    }
    if (handle && selection.length) {
      gesture.current = {
        kind: handle === 'rotate' ? 'rotate' : 'resize',
        ...p,
        ids: selection,
        bounds: selectionBounds(doc, selection),
        handle,
        pan,
      }
      return
    }
    let id =
      target.closest('[data-design-node]')?.getAttribute('data-design-node') ||
      ''
    if (id) {
      let parent = parentNode(doc, id)
      while (parent) {
        id = parent.id
        parent = parentNode(doc, id)
      }
    }
    if (id && isNodeLocked(doc, id)) return
    const ids = id
      ? event.shiftKey
        ? selection.includes(id)
          ? selection.filter((s) => s !== id)
          : [...selection, id]
        : selection.includes(id)
          ? selection
          : [id]
      : []
    store.select(ids)
    gesture.current = {
      kind: id ? 'move' : 'marquee',
      ...p,
      ids,
      bounds: selectionBounds(doc, ids),
      snapTargets: id ? designSnapTargets(doc, ids) : undefined,
      pan,
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pan') {
      setPan({
        x: g.pan.x + event.clientX - g.x,
        y: g.pan.y + event.clientY - g.y,
      })
      return
    }
    const p = position(event),
      dx = p.x - g.x,
      dy = p.y - g.y
    if (g.kind === 'marquee') {
      setMarquee({
        x: Math.min(g.x, p.x),
        y: Math.min(g.y, p.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      })
      return
    }
    if (g.kind === 'move') {
      const snapped =
        g.snapTargets && !event.altKey
          ? snapDesignMove(g.bounds, dx, dy, g.snapTargets, 6 / zoom)
          : { dx, dy, guides: {} }
      setGuides(snapped.guides)
      store.preview({
        type: 'transform',
        ids: g.ids,
        matrix: translation(snapped.dx, snapped.dy),
      })
      return
    }
    if (g.kind === 'rotate') {
      const x = g.bounds.x + g.bounds.width / 2,
        y = g.bounds.y + g.bounds.height / 2
      let angle = Math.atan2(p.y - y, p.x - x) - Math.atan2(g.y - y, g.x - x)
      if (event.shiftKey)
        angle = (Math.round(angle / (Math.PI / 12)) * Math.PI) / 12
      store.preview({
        type: 'transform',
        ids: g.ids,
        matrix: around(g.bounds, [
          Math.cos(angle),
          Math.sin(angle),
          -Math.sin(angle),
          Math.cos(angle),
          0,
          0,
        ]),
      })
      return
    }
    const b = g.bounds,
      left = g.handle?.includes('w'),
      top = g.handle?.includes('n'),
      anchor = { x: left ? b.x + b.width : b.x, y: top ? b.y + b.height : b.y }
    let sx = Math.max(
        0.01,
        (b.width + (left ? -dx : dx)) / Math.max(1, b.width),
      ),
      sy = Math.max(0.01, (b.height + (top ? -dy : dy)) / Math.max(1, b.height))
    if (event.shiftKey) {
      sx = Math.max(sx, sy)
      sy = sx
    }
    store.preview({
      type: 'transform',
      ids: g.ids,
      matrix: multiply(
        translation(anchor.x, anchor.y),
        multiply([sx, 0, 0, sy, 0, 0], translation(-anchor.x, -anchor.y)),
      ),
    })
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const g = gesture.current
    if (!g) return
    if (cancel) store.cancel()
    else if (g.kind === 'marquee' && marquee)
      store.select(
        page.children.filter((id) => {
          const b = selectionBounds(doc, [id])
          return (
            doc.nodes[id].visible &&
            !isNodeLocked(doc, id) &&
            b.x < marquee.x + marquee.width &&
            b.x + b.width > marquee.x &&
            b.y < marquee.y + marquee.height &&
            b.y + b.height > marquee.y
          )
        }),
      )
    else store.commitPreview()
    gesture.current = null
    setMarquee(null)
    setGuides({})
    const target = event.target as Element
    if (target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId)
  }
  const bounds = selectionBounds(doc, selection),
    canTransform = selection.some((id) => !isNodeLocked(doc, id))
  return (
    <div
      ref={stage}
      className={`design-stage ${space ? 'is-panning' : ''}`}
      tabIndex={active ? 0 : -1}
      aria-label={t('canvas')}
      data-testid="design-canvas"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onBlur={() => setSpace(false)}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLTextAreaElement) return
        if (event.code === 'Space') {
          event.preventDefault()
          setSpace(true)
        }
        if (event.key === 'Escape') {
          gesture.current = null
          setMarquee(null)
          setGuides({})
          store.cancel()
          setEditingId(null)
        }
      }}
      onKeyUp={(event) => {
        if (event.code === 'Space') setSpace(false)
      }}
    >
      <div
        className="design-artboard"
        style={{
          left: center.x,
          top: center.y,
          width: page.width * zoom,
          height: page.height * zoom,
        }}
      >
        <svg
          ref={svg}
          className="design-artwork"
          width={page.width * zoom}
          height={page.height * zoom}
          viewBox={`0 0 ${page.width} ${page.height}`}
          aria-label={t('artboard')}
          onDoubleClick={(event) => {
            const id = (event.target as Element)
              .closest('[data-design-node]')
              ?.getAttribute('data-design-node')
            if (
              id &&
              doc.nodes[id]?.type === 'text' &&
              !isNodeLocked(doc, id)
            ) {
              store.select([id])
              setEditingId(id)
            }
          }}
        >
          <DesignArtwork
            document={doc}
            images={images}
            prefix={doc.id}
            editingId={editingId}
          />
          <g
            className="design-snap-guides"
            stroke="hsl(var(--brand))"
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${4 / zoom}`}
            pointerEvents="none"
          >
            {guides.x !== undefined ? (
              <line x1={guides.x} x2={guides.x} y1={0} y2={page.height} />
            ) : null}
            {guides.y !== undefined ? (
              <line x1={0} x2={page.width} y1={guides.y} y2={guides.y} />
            ) : null}
          </g>
          {selection.length && !editingId ? (
            <g
              className="design-selection"
              fill="none"
              stroke="hsl(var(--brand))"
              strokeWidth={1.5 / zoom}
            >
              <rect
                x={bounds.x}
                y={bounds.y}
                width={bounds.width}
                height={bounds.height}
                pointerEvents="none"
              />
              {canTransform ? (
                <>
                  <line
                    x1={bounds.x + bounds.width / 2}
                    x2={bounds.x + bounds.width / 2}
                    y1={bounds.y}
                    y2={bounds.y - 24 / zoom}
                    pointerEvents="none"
                  />
                  <circle
                    data-design-handle="rotate"
                    cx={bounds.x + bounds.width / 2}
                    cy={bounds.y - 24 / zoom}
                    r={5 / zoom}
                    fill="hsl(var(--background))"
                    style={{ cursor: 'grab' }}
                  />
                </>
              ) : null}
              {canTransform
                ? [
                    ['nw', bounds.x, bounds.y],
                    ['ne', bounds.x + bounds.width, bounds.y],
                    ['sw', bounds.x, bounds.y + bounds.height],
                    ['se', bounds.x + bounds.width, bounds.y + bounds.height],
                  ].map(([handle, x, y]) => (
                    <rect
                      key={handle}
                      data-design-handle={handle}
                      x={Number(x) - 4 / zoom}
                      y={Number(y) - 4 / zoom}
                      width={8 / zoom}
                      height={8 / zoom}
                      fill="hsl(var(--background))"
                      style={{ cursor: `${handle}-resize` }}
                    />
                  ))
                : null}
            </g>
          ) : null}
          {marquee ? (
            <rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.width}
              height={marquee.height}
              fill="hsl(var(--accent))"
              fillOpacity={0.4}
              stroke="hsl(var(--brand))"
              strokeWidth={1 / zoom}
              pointerEvents="none"
            />
          ) : null}
        </svg>
        {editingId && doc.nodes[editingId]?.type === 'text' && active ? (
          <DesignTextEditor
            key={editingId}
            document={doc}
            id={editingId}
            zoom={zoom}
            store={store}
            onClose={() => setEditingId(null)}
          />
        ) : null}
      </div>
      <div className="design-zoom">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('zoomOut')}
          onClick={() => setZoom(Math.max(0.02, zoom / 1.2))}
        >
          <Minus />
        </Button>
        <span>{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('zoomIn')}
          onClick={() => setZoom(Math.min(4, zoom * 1.2))}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('fit')}
          onClick={() => {
            setZoom(null)
            setPan({ x: 0, y: 0 })
          }}
        >
          <Maximize />
        </Button>
      </div>
    </div>
  )
}
