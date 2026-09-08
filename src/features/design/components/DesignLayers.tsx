import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignDocument } from '../lib/designTypes'
import type { DesignStore } from '../lib/designStore'
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
  function layer(id: string, depth: number) {
    const n = doc.nodes[id]
    return (
      <div key={id}>
        <div
          className={`design-layer ${selection.includes(id) ? 'is-selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
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
            onClick={() =>
              store.execute({
                type: 'patch',
                ids: [id],
                patch: { visible: !n.visible },
              })
            }
          >
            {n.visible ? <Eye /> : <EyeOff />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={n.locked ? t('unlock') : t('lock')}
            aria-label={`${n.locked ? t('unlock') : t('lock')} ${n.name}`}
            onClick={() =>
              store.execute({
                type: 'patch',
                ids: [id],
                patch: { locked: !n.locked },
              })
            }
          >
            {n.locked ? <Lock /> : <Unlock />}
          </Button>
        </div>
        {[...n.children].reverse().map((child) => layer(child, depth + 1))}
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
            onClick={() =>
              store.execute({
                type: 'reorder',
                id: selection[0],
                direction: direction as -1 | 1,
              })
            }
          >
            {direction === 1 ? <ArrowUp /> : <ArrowDown />}
          </Button>
        ))}
      </div>
      {[...doc.pages[0].children].reverse().map((id) => layer(id, 0))}
      {!doc.pages[0].children.length ? (
        <p className="design-help p-4">{t('emptyLayers')}</p>
      ) : null}
    </>
  )
}
