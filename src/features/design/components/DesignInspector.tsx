import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignDocument, DesignNode } from '../lib/designTypes'
import { DesignStore } from '../lib/designStore'
import {
  around,
  isNodeLocked,
  selectionBounds,
  translation,
  worldMatrix,
} from '../lib/designGeometry'
import { DesignColorField, DesignNumberField } from './DesignFields'
export function DesignInspector({
  document: doc,
  selection,
  store,
}: {
  document: DesignDocument
  selection: string[]
  store: DesignStore
}) {
  const { t } = useTranslation('design'),
    n = selection.length === 1 ? doc.nodes[selection[0]] : null,
    page = doc.pages[0]
  const patch = (value: Partial<DesignNode>) =>
    store.execute({ type: 'patch', ids: selection, patch: value })
  const bounds = selectionBounds(doc, selection)
  function align(axis: 'x' | 'y') {
    store.execute({ type: 'align', ids: selection, axis })
  }
  if (!selection.length)
    return (
      <div className="design-properties">
        <p className="design-panel-heading">{t('artboard')}</p>
        <label className="design-field">
          <span>{t('size')}</span>
          <select
            aria-label={t('size')}
            value=""
            onChange={(event) => {
              const [width, height] = event.target.value.split('x').map(Number)
              if (width && height)
                store.execute({ type: 'page', patch: { width, height } })
            }}
          >
            <option value="">{t('custom')}</option>
            <option value="1080x1440">{t('sizes.poster')}</option>
            <option value="1080x1080">{t('sizes.square')}</option>
            <option value="1080x1920">{t('sizes.story')}</option>
            <option value="1920x1080">{t('sizes.landscape')}</option>
          </select>
        </label>
        <div className="design-field-grid">
          <DesignNumberField
            label={t('width')}
            value={page.width}
            min={1}
            onChange={(width) =>
              store.execute({ type: 'page', patch: { width } })
            }
          />
          <DesignNumberField
            label={t('height')}
            value={page.height}
            min={1}
            onChange={(height) =>
              store.execute({ type: 'page', patch: { height } })
            }
          />
        </div>
        <DesignColorField
          label={t('background')}
          value={page.background}
          onChange={(background) =>
            store.execute({ type: 'page', patch: { background } })
          }
        />
        <label className="design-check">
          <input
            type="checkbox"
            checked={page.background === 'transparent'}
            onChange={(event) =>
              store.execute({
                type: 'page',
                patch: {
                  background: event.target.checked ? 'transparent' : '#ffffff',
                },
              })
            }
          />
          {t('transparent')}
        </label>
        <p className="design-help">{t('artboardHint')}</p>
      </div>
    )
  const m = n ? worldMatrix(doc, n.id) : null,
    angle = m ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : 0
  const scaleX = m ? Math.hypot(m[0], m[1]) : 1,
    scaleY = m ? Math.hypot(m[2], m[3]) : 1
  return (
    <fieldset
      className="design-properties"
      disabled={selection.some((id) => isNodeLocked(doc, id))}
    >
      <p className="design-panel-heading">
        {n ? t(`tools.${n.type}`) : t('selected', { count: selection.length })}
      </p>
      {n ? (
        <label className="design-field">
          <span>{t('name')}</span>
          <input
            aria-label={t('name')}
            key={n.id + n.name}
            defaultValue={n.name}
            onBlur={(event) =>
              patch({ name: event.target.value.slice(0, 1000) })
            }
          />
        </label>
      ) : null}
      <div className="design-field-grid">
        <DesignNumberField
          label="X"
          value={bounds.x}
          onChange={(x) =>
            store.execute({
              type: 'transform',
              ids: selection,
              matrix: translation(x - bounds.x, 0),
            })
          }
        />
        <DesignNumberField
          label="Y"
          value={bounds.y}
          onChange={(y) =>
            store.execute({
              type: 'transform',
              ids: selection,
              matrix: translation(0, y - bounds.y),
            })
          }
        />
        {n && n.type !== 'group' ? (
          <>
            <DesignNumberField
              label={t('width')}
              value={n.width * scaleX}
              min={1}
              onChange={(width) => patch({ width: width / scaleX })}
            />
            <DesignNumberField
              label={t('height')}
              value={n.height * scaleY}
              min={1}
              onChange={(height) => patch({ height: height / scaleY })}
            />
          </>
        ) : null}
        <DesignNumberField
          label={t('rotation')}
          value={angle}
          min={-360}
          max={360}
          onChange={(value) => {
            const r = ((value - angle) * Math.PI) / 180
            store.execute({
              type: 'transform',
              ids: selection,
              matrix: around(bounds, [
                Math.cos(r),
                Math.sin(r),
                -Math.sin(r),
                Math.cos(r),
                0,
                0,
              ]),
            })
          }}
        />
        {n ? (
          <DesignNumberField
            label={t('opacity')}
            value={n.opacity * 100}
            min={0}
            max={100}
            onChange={(value) => patch({ opacity: value / 100 })}
          />
        ) : null}
      </div>
      <div className="design-action-grid">
        <Button variant="ghost" size="sm" onClick={() => align('x')}>
          {t('centerX')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => align('y')}>
          {t('centerY')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            store.execute({
              type: 'transform',
              ids: selection,
              matrix: around(bounds, [-1, 0, 0, 1, 0, 0]),
            })
          }
        >
          {t('flipX')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            store.execute({
              type: 'transform',
              ids: selection,
              matrix: around(bounds, [1, 0, 0, -1, 0, 0]),
            })
          }
        >
          {t('flipY')}
        </Button>
      </div>
      {n && !['image', 'group', 'line'].includes(n.type) ? (
        <DesignColorField
          label={t('fill')}
          value={n.fill}
          onChange={(fill) => patch({ fill })}
        />
      ) : null}
      {n && ['rectangle', 'ellipse', 'line'].includes(n.type) ? (
        <>
          <DesignColorField
            label={t('stroke')}
            value={n.stroke}
            onChange={(stroke) => patch({ stroke })}
          />
          <DesignNumberField
            label={t('strokeWidth')}
            value={n.strokeWidth}
            min={0}
            max={1000}
            onChange={(strokeWidth) => patch({ strokeWidth })}
          />
        </>
      ) : null}
      {n && ['rectangle', 'image'].includes(n.type) ? (
        <DesignNumberField
          label={t('radius')}
          value={n.radius}
          min={0}
          max={8192}
          onChange={(radius) => patch({ radius })}
        />
      ) : null}
      {n?.type === 'text' ? (
        <>
          <p className="design-panel-heading">{t('typography')}</p>
          <label className="design-field">
            <span>{t('font')}</span>
            <select
              aria-label={t('font')}
              value={n.fontFamily}
              onChange={(event) =>
                patch({
                  fontFamily: event.target.value as DesignNode['fontFamily'],
                })
              }
            >
              {['Arial', 'Georgia', 'Courier New'].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <div className="design-field-grid">
            <DesignNumberField
              label={t('fontSize')}
              value={n.fontSize}
              min={1}
              max={2000}
              onChange={(fontSize) => patch({ fontSize })}
            />
            <label className="design-field">
              <span>{t('weight')}</span>
              <select
                aria-label={t('weight')}
                value={n.fontWeight}
                onChange={(event) =>
                  patch({ fontWeight: Number(event.target.value) })
                }
              >
                <option value={400}>{t('regular')}</option>
                <option value={700}>{t('bold')}</option>
              </select>
            </label>
            <DesignNumberField
              label={t('lineHeight')}
              value={n.lineHeight}
              min={0.5}
              max={4}
              step={0.1}
              onChange={(lineHeight) => patch({ lineHeight })}
            />
            <DesignNumberField
              label={t('spacing')}
              value={n.letterSpacing}
              min={-100}
              max={500}
              onChange={(letterSpacing) => patch({ letterSpacing })}
            />
          </div>
          <label className="design-field">
            <span>{t('textAlign')}</span>
            <select
              aria-label={t('textAlign')}
              value={n.textAlign}
              onChange={(event) =>
                patch({
                  textAlign: event.target.value as DesignNode['textAlign'],
                })
              }
            >
              {(['left', 'center', 'right'] as const).map((value) => (
                <option value={value} key={value}>
                  {t(value)}
                </option>
              ))}
            </select>
          </label>
          <p className="design-help">{t('editTextHint')}</p>
        </>
      ) : null}
      {n?.type === 'image' && n.crop ? (
        <>
          <p className="design-panel-heading">{t('crop')}</p>
          <p className="design-help">{t('cropHint')}</p>
          <div className="design-field-grid">
            {(['x', 'y', 'width', 'height'] as const).map((key) => {
              const asset = doc.assets[n.assetId!],
                crop = n.crop!,
                max =
                  key === 'x'
                    ? asset.width - crop.width
                    : key === 'y'
                      ? asset.height - crop.height
                      : key === 'width'
                        ? asset.width - crop.x
                        : asset.height - crop.y
              return (
                <DesignNumberField
                  key={key}
                  label={`${t('crop')} ${key === 'x' || key === 'y' ? key.toUpperCase() : t(key)}`}
                  value={crop[key]}
                  min={key === 'x' || key === 'y' ? 0 : 1}
                  max={max}
                  onChange={(value) =>
                    patch({ crop: { ...crop, [key]: value } })
                  }
                />
              )
            })}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const a = doc.assets[n.assetId!]
              patch({ crop: { x: 0, y: 0, width: a.width, height: a.height } })
            }}
          >
            {t('resetCrop')}
          </Button>
        </>
      ) : null}
      <div className="design-action-grid">
        <Button
          size="sm"
          variant="secondary"
          disabled={selection.length < 2}
          onClick={() => {
            store.execute({ type: 'group', ids: selection })
            store.select([])
          }}
        >
          {t('group')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={n?.type !== 'group' || n.opacity !== 1}
          onClick={() => store.execute({ type: 'ungroup', ids: selection })}
        >
          {t('ungroup')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => store.execute({ type: 'duplicate', ids: selection })}
        >
          {t('duplicate')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => store.execute({ type: 'remove', ids: selection })}
        >
          {t('delete')}
        </Button>
      </div>
    </fieldset>
  )
}
