import {
  ChevronDown,
  Copy,
  Download,
  FileText,
  Redo2,
  Table2,
  Undo2,
  WandSparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignSaveStatus } from '../lib/designSession'
import type { DesignExportPresets } from '../lib/designExportPresets'
import type { DesignExportFormat } from '../hooks/useDesignFileActions'
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
  onGenerateImage,
  brandMenu,
  presets,
  onPresetsChange,
  pdfAvailable,
  canSendToTable,
  onHandoff,
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
  onExport: (format: DesignExportFormat) => void
  presets: DesignExportPresets
  onPresetsChange: (patch: Partial<DesignExportPresets>) => void
  /** PDF needs the desktop; the item is hidden elsewhere. */
  pdfAvailable: boolean
  /** True when the design came from a table record and can go back as an attachment. */
  canSendToTable: boolean
  onHandoff: (kind: 'document' | 'table') => void
  /** Opens the image studio; hidden when the runtime cannot generate. */
  onGenerateImage?: () => void
  /** The Brand menu, when the workspace has a brand kit. */
  brandMenu?: ReactNode
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
      {brandMenu}
      {onGenerateImage ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={onGenerateImage}
          aria-label={t('generateImage')}
        >
          <WandSparkles className="size-4" />
          {t('generateImage')}
        </Button>
      ) : null}
      <details className="design-export">
        <summary aria-label={t('export')}>
          <Download className="size-4" />
          <span>{t('export')}</span>
          <ChevronDown className="size-3" />
        </summary>
        <div className="design-export-menu">
          <label className="design-export-option">
            <span>{t('exportScale')}</span>
            <select
              aria-label={t('exportScale')}
              value={presets.scale}
              onChange={(event) =>
                onPresetsChange({
                  scale: Number(event.target.value) as DesignExportPresets['scale'],
                })
              }
            >
              {[1, 2, 3].map((scale) => (
                <option key={scale} value={scale}>
                  {scale}×
                </option>
              ))}
            </select>
          </label>
          <label className="design-export-option">
            <span>{t('exportBackground')}</span>
            <select
              aria-label={t('exportBackground')}
              value={presets.background}
              onChange={(event) =>
                onPresetsChange({
                  background: event.target
                    .value as DesignExportPresets['background'],
                })
              }
            >
              {(['keep', 'transparent', 'white'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`exportBackgrounds.${value}`)}
                </option>
              ))}
            </select>
          </label>
          {(
            ['png', 'jpeg', 'svg', ...(pdfAvailable ? ['pdf' as const] : []), 'copy', 'all'] as const
          ).map((format) => (
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
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open')
              onHandoff('document')
            }}
          >
            <FileText className="size-4" />
            {t('insertIntoDocument')}
          </Button>
          {canSendToTable ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open')
                onHandoff('table')
              }}
            >
              <Table2 className="size-4" />
              {t('sendToTable')}
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  )
}
