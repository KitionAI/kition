import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignDocument } from '../lib/designTypes'
import type { DesignStore } from '../lib/designStore'

const ROW_HEIGHT = 36
const OVERSCAN = 8

/** Layers in panel order (top of the stack first), with their nesting depth. */
export function designLayerRows(doc: DesignDocument): Array<{ id: string; depth: number }> {
  const rows: Array<{ id: string; depth: number }> = []
  const visit = (ids: readonly string[], depth: number) => {
    for (const id of [...ids].reverse()) {
      const node = doc.nodes[id]
      if (!node) continue
      rows.push({ id, depth })
      visit(node.children, depth + 1)
    }
  }
  visit(doc.pages[0].children, 0)
  return rows
}

/** The slice of rows worth rendering for a scroll position, with padding around it. */
export function designLayerWindow(total: number, scrollTop: number, height: number) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  return { start, end, top: start * ROW_HEIGHT, bottom: (total - end) * ROW_HEIGHT }
}

export function DesignLayers({
  document: doc,
  selection,
  store,
}: {
  document: DesignDocument
  selection: string[]
  store: DesignStore
}) {
  const { t } = useTranslation('design')
  const list = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 600 })
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight || 600 })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const rows = designLayerRows(doc)
  const window = designLayerWindow(rows.length, viewport.scrollTop, viewport.height)
  function layer({ id, depth }: { id: string; depth: number }) {
    const n = doc.nodes[id]
    return (
      <div
        key={id}
        className={`design-layer ${selection.includes(id) ? 'is-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 12, height: ROW_HEIGHT }}
      >
        <button
          type="button"
          className="design-layer-name"
          aria-pressed={selection.includes(id)}
          onClick={(event) =>
            store.select(
              event.shiftKey
                ? selection.includes(id)
                  ? selection.filter((s) => s !== id)
                  : [...selection, id]
                : [id],
            )
          }
        >
          {n.name || t(`tools.${n.type}`)}
        </button>
        <Button
          variant="ghost"
          size="icon"
          title={n.visible ? t('hide') : t('show')}
          aria-label={`${n.visible ? t('hide') : t('show')} ${n.name}`}
          onClick={() => store.execute({ type: 'patch', ids: [id], patch: { visible: !n.visible } })}
        >
          {n.visible ? <Eye /> : <EyeOff />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={n.locked ? t('unlock') : t('lock')}
          aria-label={`${n.locked ? t('unlock') : t('lock')} ${n.name}`}
          onClick={() => store.execute({ type: 'patch', ids: [id], patch: { locked: !n.locked } })}
        >
          {n.locked ? <Lock /> : <Unlock />}
        </Button>
      </div>
    )
  }
  return (
    <>
      <div className="design-layer-actions">
        <span>{t('layers')}</span>
        {[-1, 1].map((direction) => (
          <Button
            key={direction}
            size="icon"
            variant="ghost"
            disabled={selection.length !== 1}
            aria-label={direction === 1 ? t('bringForward') : t('sendBackward')}
            onClick={() => store.execute({ type: 'reorder', id: selection[0], direction: direction as -1 | 1 })}
          >
            {direction === 1 ? <ArrowUp /> : <ArrowDown />}
          </Button>
        ))}
      </div>
      {/* Only the rows in view render, so thousands of layers stay cheap. */}
      <div
        ref={list}
        className="design-layer-list"
        data-testid="design-layer-list"
        onScroll={(event) =>
          setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
        }
      >
        <div style={{ height: window.top }} />
        {rows.slice(window.start, window.end).map(layer)}
        <div style={{ height: window.bottom }} />
      </div>
      {!doc.pages[0].children.length ? <p className="design-help p-4">{t('emptyLayers')}</p> : null}
    </>
  )
}
