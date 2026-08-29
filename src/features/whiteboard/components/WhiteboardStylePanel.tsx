import { Ban, Grid3X3, Square, SunMedium } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import {
  WHITEBOARD_COLOR_TOKENS,
  WHITEBOARD_DASH_STYLES,
  WHITEBOARD_FILL_STYLES,
  WHITEBOARD_STROKE_SIZES,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import type {
  WhiteboardColorToken,
  WhiteboardDashStyle,
  WhiteboardFillStyle,
} from '../lib/whiteboardTypes'
import { cn } from '@/lib/utils'

const FILL_ICONS = {
  none: Ban,
  solid: Square,
  semi: SunMedium,
  pattern: Grid3X3,
} satisfies Record<WhiteboardFillStyle, typeof Square>

export function WhiteboardStylePanel({
  controller,
}: {
  controller: WhiteboardEditorController
}) {
  const { t } = useTranslation('workspace')
  const [opacity, setOpacity] = useState(Math.round(controller.activeStyle.opacity * 100))
  const visible = (controller.tool === 'select' && controller.hasSelection) || [
    'rectangle',
    'note',
    'pen',
    'highlight',
    'connector',
    'text',
  ].includes(controller.tool)
  const enabled = !controller.hasSelection || controller.hasUnlockedSelection
  const selectedConnector = controller.selectedElements.find((element) => element.kind === 'connector')

  useEffect(() => {
    setOpacity(Math.round(controller.activeStyle.opacity * 100))
  }, [controller.activeStyle.opacity])

  if (!visible) return null

  function commitOpacity() {
    const next = opacity / 100
    if (Math.abs(next - controller.activeStyle.opacity) > 0.005) {
      controller.applyStyle({ opacity: next })
    }
  }

  return (
    <aside
      className="absolute right-4 top-1/2 z-20 w-52 -translate-y-1/2 rounded-xl border bg-background/95 p-3 shadow-[var(--shadow-toolbar)] backdrop-blur"
      aria-label={t('board.style.label')}
      data-testid="whiteboard-style-panel"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('board.style.label')}</h2>
        <span className="text-[11px] text-muted-foreground">
          {controller.hasSelection ? t('board.style.selection') : t('board.style.defaults')}
        </span>
      </div>

      <StyleSection label={t('board.style.strokeColor')}>
        <ColorRow
          enabled={enabled}
          selected={controller.activeStyle.strokeColor}
          onSelect={(strokeColor) => controller.applyStyle({ strokeColor })}
          role="stroke"
        />
      </StyleSection>

      <StyleSection label={t('board.style.fillColor')}>
        <ColorRow
          enabled={enabled}
          selected={controller.activeStyle.fillColor}
          onSelect={(fillColor) => controller.applyStyle({ fillColor })}
          role="fill"
        />
      </StyleSection>

      <StyleSection label={`${t('board.style.opacity')} ${opacity}%`}>
        <input
          className="whiteboard-opacity-input"
          type="range"
          min="5"
          max="100"
          step="5"
          value={opacity}
          disabled={!enabled}
          onChange={(event) => setOpacity(Number(event.target.value))}
          onPointerUp={commitOpacity}
          onKeyUp={commitOpacity}
          onBlur={commitOpacity}
          aria-label={t('board.style.opacity')}
          data-testid="whiteboard-style-opacity"
        />
      </StyleSection>

      <StyleSection label={t('board.style.fill')}>
        <div className="grid grid-cols-4 gap-1">
          {WHITEBOARD_FILL_STYLES.map((fillStyle) => {
            const Icon = FILL_ICONS[fillStyle]
            return (
              <StyleIconButton
                key={fillStyle}
                active={controller.activeStyle.fillStyle === fillStyle}
                disabled={!enabled}
                label={t(`board.style.fillStyles.${fillStyle}`)}
                onClick={() => controller.applyStyle({ fillStyle })}
                testId={`whiteboard-fill-${fillStyle}`}
              >
                <Icon className="size-3.5" />
              </StyleIconButton>
            )
          })}
        </div>
      </StyleSection>

      <StyleSection label={t('board.style.line')}>
        <div className="grid grid-cols-3 gap-1">
          {WHITEBOARD_DASH_STYLES.map((dashStyle) => (
            <StyleIconButton
              key={dashStyle}
              active={controller.activeStyle.dashStyle === dashStyle}
              disabled={!enabled}
              label={t(`board.style.dashStyles.${dashStyle}`)}
              onClick={() => controller.applyStyle({ dashStyle })}
              testId={`whiteboard-dash-${dashStyle}`}
            >
              <DashPreview dashStyle={dashStyle} />
            </StyleIconButton>
          ))}
        </div>
      </StyleSection>

      {selectedConnector?.kind === 'connector' ? (
        <>
          <StyleSection label={t('board.style.connectorType')}>
            <div className="grid grid-cols-3 gap-1">
              {(['straight', 'elbow', 'curved'] as const).map((connectorType) => (
                <button
                  key={connectorType}
                  type="button"
                  className={cn(
                    'h-8 rounded-md text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground',
                    (selectedConnector.connectorType || 'straight') === connectorType
                      && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => controller.updateSelectedConnectors({ connectorType })}
                  aria-label={t(`board.style.connectorTypes.${connectorType}`)}
                  data-testid={`whiteboard-connector-type-${connectorType}`}
                >
                  {t(`board.style.connectorTypeShort.${connectorType}`)}
                </button>
              ))}
            </div>
          </StyleSection>
          <StyleSection label={t('board.style.arrowheads')}>
            <div className="grid grid-cols-2 gap-2">
              <ArrowheadSelect
                label={t('board.style.startArrowhead')}
                value={selectedConnector.startArrowhead || 'none'}
                onChange={(startArrowhead) => controller.updateSelectedConnectors({ startArrowhead })}
                testId="whiteboard-connector-start-arrowhead"
              />
              <ArrowheadSelect
                label={t('board.style.endArrowhead')}
                value={selectedConnector.endArrowhead || 'arrow'}
                onChange={(endArrowhead) => controller.updateSelectedConnectors({ endArrowhead })}
                testId="whiteboard-connector-end-arrowhead"
              />
            </div>
          </StyleSection>
        </>
      ) : null}

      <StyleSection label={t('board.style.size')} last>
        <div className="grid grid-cols-4 gap-1">
          {WHITEBOARD_STROKE_SIZES.map((strokeSize) => (
            <button
              key={strokeSize}
              type="button"
              className={cn(
                'h-8 rounded-md text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:bg-muted disabled:text-muted-foreground',
                controller.activeStyle.strokeSize === strokeSize && 'bg-accent text-accent-foreground',
              )}
              disabled={!enabled}
              onClick={() => controller.applyStyle({ strokeSize })}
              aria-label={t(`board.style.sizes.${strokeSize}`)}
              title={t(`board.style.sizes.${strokeSize}`)}
              data-testid={`whiteboard-size-${strokeSize}`}
            >
              {strokeSize.toUpperCase()}
            </button>
          ))}
        </div>
      </StyleSection>
    </aside>
  )
}

function StyleSection({
  children,
  label,
  last = false,
}: {
  children: ReactNode
  label: string
  last?: boolean
}) {
  return (
    <section className={cn('whiteboard-style-section border-b py-2.5', last && 'is-last')}>
      <div className="mb-2 text-[11px] font-semibold text-muted-foreground">{label}</div>
      {children}
    </section>
  )
}

function ColorRow({
  enabled,
  onSelect,
  role,
  selected,
}: {
  enabled: boolean
  onSelect: (token: WhiteboardColorToken) => void
  role: 'stroke' | 'fill'
  selected: WhiteboardColorToken
}) {
  const { t } = useTranslation('workspace')
  return (
    <div className="whiteboard-color-grid grid gap-1">
      {WHITEBOARD_COLOR_TOKENS.map((token) => (
        <button
          key={token}
          type="button"
          className={cn(
            'whiteboard-color-swatch flex size-4 items-center justify-center rounded-sm border disabled:opacity-40',
            selected === token && 'is-selected',
          )}
          style={{ backgroundColor: resolveWhiteboardColor(token, role) }}
          disabled={!enabled}
          onClick={() => onSelect(token)}
          aria-label={t(`board.style.colors.${token}`)}
          title={t(`board.style.colors.${token}`)}
          data-testid={`whiteboard-${role}-color-${token}`}
        />
      ))}
    </div>
  )
}

function StyleIconButton({
  active,
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
  active: boolean
  children: ReactNode
  disabled: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:bg-muted disabled:text-muted-foreground',
        active && 'bg-accent text-accent-foreground',
      )}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

function DashPreview({ dashStyle }: { dashStyle: WhiteboardDashStyle }) {
  const borderStyle = dashStyle === 'solid'
    ? 'solid'
    : dashStyle === 'dashed'
      ? 'dashed'
      : 'dotted'
  return <span className="whiteboard-dash-preview" style={{ borderTopStyle: borderStyle }} />
}

function ArrowheadSelect({
  label,
  onChange,
  testId,
  value,
}: {
  label: string
  onChange: (value: 'none' | 'arrow' | 'dot') => void
  testId: string
  value: 'none' | 'arrow' | 'dot'
}) {
  const { t } = useTranslation('workspace')
  return (
    <label className="grid gap-1 text-[10px] font-medium text-muted-foreground">
      {label}
      <select
        className="h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
        value={value}
        onChange={(event) => onChange(event.target.value as 'none' | 'arrow' | 'dot')}
        data-testid={testId}
      >
        {(['none', 'arrow', 'dot'] as const).map((option) => (
          <option key={option} value={option}>{t(`board.style.arrowheadTypes.${option}`)}</option>
        ))}
      </select>
    </label>
  )
}
