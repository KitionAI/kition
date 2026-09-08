import { ChevronDown, Copy, Download, Redo2, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignSaveStatus } from '../lib/designSession'
export function DesignToolbar({
  title,
  status,
  size,
  canUndo,
  canRedo,
  busy,
  onUndo,
  onRedo,
  onSize,
  onExport,
}: {
  title: string
  status: DesignSaveStatus
  size: string
  canUndo: boolean
  canRedo: boolean
  busy: boolean
  onUndo: () => void
  onRedo: () => void
  onSize: () => void
  onExport: (format: 'png' | 'jpeg' | 'copy') => void
}) {
  const { t } = useTranslation('design')
  return (
    <div className="design-toolbar">
      <div className="design-title">
        <strong title={title}>{title}</strong>
        <span role="status" data-testid="design-save-status">
          {t(`status.${status}`)}
        </span>
      </div>
      <div className="design-history">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('undo')}
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('redo')}
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 />
        </Button>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="design-size-button"
        onClick={onSize}
        aria-label={t('artboardSize')}
      >
        {size}
        <ChevronDown className="size-3" />
      </Button>
      <details className="design-export">
        <summary aria-label={t('export')}>
          <Download className="size-4" />
          <span>{t('export')}</span>
          <ChevronDown className="size-3" />
        </summary>
        <div className="design-export-menu">
          {(['png', 'jpeg', 'copy'] as const).map((format) => (
            <Button
              key={format}
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open')
                onExport(format)
              }}
            >
              {format === 'copy' ? (
                <Copy className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              {t(`exportFormats.${format}`)}
            </Button>
          ))}
        </div>
      </details>
    </div>
  )
}
