import { FileUp, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  documentExportFormats,
  documentExportMarginsOptions,
  documentExportPageFormats,
  type DocumentExportFormat,
  type DocumentExportMarginsType,
  type DocumentExportPageFormat,
} from '@/features/document/hooks/useDocumentExport'

type Props = {
  open: boolean
  exporting: boolean
  exportFormat: DocumentExportFormat
  exportIncludeMedia: boolean
  exportPageFormat: DocumentExportPageFormat
  exportScale: string
  pdfIncludeName: boolean
  pdfLandscape: boolean
  pdfMarginsType: DocumentExportMarginsType
  onClose: () => void
  onExportFormatChange: (value: DocumentExportFormat) => void
  onIncludeMediaChange: (value: boolean) => void
  onPageFormatChange: (value: DocumentExportPageFormat) => void
  onScaleChange: (value: string) => void
  onPdfIncludeNameChange: (value: boolean) => void
  onPdfLandscapeChange: (value: boolean) => void
  onPdfMarginsTypeChange: (value: DocumentExportMarginsType) => void
  onExport: () => void
}

function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const { t } = useTranslation('document')
  return (
    <span className={cn('el-switch', checked && 'is-checked')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        className="settings-switch-button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        {checked ? t('export.toggleOn') : t('export.toggleOff')}
      </button>
    </span>
  )
}

export function DocumentExportDialog({
  open,
  exporting,
  exportFormat,
  exportIncludeMedia,
  exportPageFormat,
  exportScale,
  pdfIncludeName,
  pdfLandscape,
  pdfMarginsType,
  onClose,
  onExportFormatChange,
  onIncludeMediaChange,
  onPageFormatChange,
  onScaleChange,
  onPdfIncludeNameChange,
  onPdfLandscapeChange,
  onPdfMarginsTypeChange,
  onExport,
}: Props) {
  const { t } = useTranslation('document')

  if (!open) {
    return null
  }

  const scaleNumber = Number(exportScale)
  const invalidScale = scaleNumber < 10 || scaleNumber > 100 || Number.isNaN(scaleNumber)
  const showIncludeMedia = exportFormat === 'markdown' || exportFormat === 'html' || exportFormat === 'word'

  return (
    <div className="document-export-overlay" role="presentation" data-window-drag-exclude="true">
      <div
        className="document-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-export-title"
      >
        <button
          type="button"
          className="document-export-close"
          onClick={onClose}
          aria-label={t('export.closeDialog')}
          disabled={exporting}
        >
          <X className="size-5" />
        </button>
        <div className="document-export-header">
          <h2 id="document-export-title">{t('export.title')}</h2>
          <p>{t('export.subtitle')}</p>
        </div>
        <div className="document-export-form">
          <label className="document-export-row">
            <span>{t('export.formatLabel')}</span>
            <Select
              value={exportFormat}
              onChange={(event) => onExportFormatChange(event.target.value as DocumentExportFormat)}
              disabled={exporting}
              aria-label={t('export.formatLabel')}
            >
              {documentExportFormats.map((item) => (
                <option key={item.value} value={item.value}>{t(`export.formats.${item.value}`, { defaultValue: item.label })}</option>
              ))}
            </Select>
          </label>

          {showIncludeMedia ? (
            <label className="document-export-row">
              <span>{t('export.includeContentLabel')}</span>
              <Select
                value={exportIncludeMedia ? 'everything' : 'text'}
                onChange={(event) => onIncludeMediaChange(event.target.value === 'everything')}
                disabled={exporting}
                aria-label={t('export.includeContentLabel')}
              >
                <option value="everything">{t('export.includeEverything')}</option>
                <option value="text">{t('export.includeTextOnly')}</option>
              </Select>
            </label>
          ) : null}

          {exportFormat === 'pdf' ? (
            <>
              <label className="document-export-row">
                <span>{t('export.useNoteNameLabel')}</span>
                <ToggleSwitch
                  checked={pdfIncludeName}
                  onChange={onPdfIncludeNameChange}
                  ariaLabel={t('export.useNoteNameLabel')}
                  disabled={exporting}
                />
              </label>
              <label className="document-export-row">
                <span>{t('export.pageSizeLabel')}</span>
                <Select
                  value={exportPageFormat}
                  onChange={(event) => onPageFormatChange(event.target.value as DocumentExportPageFormat)}
                  disabled={exporting}
                  aria-label={t('export.pageSizeLabel')}
                >
                  {documentExportPageFormats.map((item) => (
                    <option key={item.value} value={item.value}>{t(`export.pageSizes.${item.value}`, { defaultValue: item.label })}</option>
                  ))}
                </Select>
              </label>
              <label className="document-export-row">
                <span>{t('export.landscapeLabel')}</span>
                <ToggleSwitch
                  checked={pdfLandscape}
                  onChange={onPdfLandscapeChange}
                  ariaLabel={t('export.landscapeOrientation')}
                  disabled={exporting}
                />
              </label>
              <label className="document-export-row">
                <span>{t('export.marginsLabel')}</span>
                <Select
                  value={String(pdfMarginsType)}
                  onChange={(event) => onPdfMarginsTypeChange(Number(event.target.value) as DocumentExportMarginsType)}
                  disabled={exporting}
                  aria-label={t('export.marginsLabel')}
                >
                  {documentExportMarginsOptions.map((item) => (
                    <option key={item.value} value={String(item.value)}>{t(`export.margins.${item.value}`, { defaultValue: item.label })}</option>
                  ))}
                </Select>
              </label>
              <label className="document-export-row">
                <span>{t('export.scaleLabel')}</span>
                <Input
                  value={exportScale}
                  onChange={(event) => onScaleChange(event.target.value)}
                  disabled={exporting}
                  inputMode="numeric"
                  aria-label={t('export.scalePercent')}
                />
              </label>
              {invalidScale ? (
                <p className="document-export-error">{t('export.scaleError')}</p>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="document-export-footer">
          <Button
            type="button"
            onClick={onExport}
            disabled={exporting || (exportFormat === 'pdf' && invalidScale)}
          >
            {exporting ? <LoaderCircle className="size-4 animate-spin" /> : <FileUp className="size-4" />}
            {exporting ? t('export.exporting') : t('export.exportFile')}
          </Button>
        </div>
      </div>
    </div>
  )
}
