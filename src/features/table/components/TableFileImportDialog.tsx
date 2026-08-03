import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileSpreadsheet, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  DataImportField,
  DataImportJob,
  DataImportResult,
  DataImportWriteMode,
} from '@/api/dataImports'
import { Button, Input, Select } from '@/components/ui'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import {
  cancelPreparedTableFileImport,
  executePreparedTableFileImport,
  prepareTableFileImport,
  type PreparedTableFileImport,
  type TableFileImportTarget,
} from '@/features/table/lib/tableFileImport'

const IMPORT_FIELD_TYPES: DataImportField['type'][] = [
  'text',
  'long_text',
  'number',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'checkbox',
  'url',
]

function displayCellValue(value: string | number | boolean | null) {
  if (value === null) return ''
  return String(value)
}

function defaultKitablePath(file: File | null, folder = '') {
  const title = file?.name.replace(/\.(?:csv|tsv|xlsx)$/i, '').trim() || 'Imported table'
  return `${folder ? `${folder.replace(/\/+$/, '')}/` : ''}${title}.kitable`
}

export function TableFileImportDialog({
  file,
  onCompleted,
  onOpenChange,
  open,
  target,
}: {
  file: File | null
  onCompleted: (result: DataImportResult) => void | Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  target: Extract<TableFileImportTarget, { kind: 'existing_table' }> | { kind: 'new_document'; folder?: string }
}) {
  const { t } = useTranslation('table')
  const [prepared, setPrepared] = useState<PreparedTableFileImport | null>(null)
  const [fieldTypes, setFieldTypes] = useState<DataImportField['type'][]>([])
  const [writeMode, setWriteMode] = useState<DataImportWriteMode>('append')
  const [selectedSheet, setSelectedSheet] = useState('')
  const [destinationPath, setDestinationPath] = useState('')
  const [job, setJob] = useState<DataImportJob | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)
  const targetFolder = target.kind === 'new_document' && 'folder' in target ? target.folder : ''

  useEffect(() => {
    if (!open || !file) return
    let active = true
    setLoading(true)
    setPrepared(null)
    setJob(null)
    setError('')
    void prepareTableFileImport(file, {
      requireRuntime: target.kind === 'new_document',
      sheet: selectedSheet || undefined,
    })
      .then((next) => {
        if (!active) return
        setPrepared(next)
        setFieldTypes(next.preview.fields.map((field) => field.type))
        if (!selectedSheet && next.preview.selected_sheet) {
          setSelectedSheet(next.preview.selected_sheet)
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : t('fileImport.previewFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [file, open, selectedSheet, t, target.kind])

  useEffect(() => {
    if (!open || target.kind !== 'new_document') return
    setDestinationPath(defaultKitablePath(file, targetFolder))
  }, [file, open, target.kind, targetFolder])

  useEffect(() => {
    if (open) return
    setPrepared(null)
    setFieldTypes([])
    setSelectedSheet('')
    setJob(null)
    setError('')
  }, [open])

  const progressPercent = useMemo(() => {
    if (!job?.total_rows) return running ? 5 : 0
    return Math.min(100, Math.round((job.processed_rows / job.total_rows) * 100))
  }, [job, running])

  async function handleImport() {
    if (!prepared) return
    setRunning(true)
    setError('')
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const completed = await executePreparedTableFileImport({
        fieldTypes,
        onProgress: setJob,
        prepared,
        signal: controller.signal,
        target: target.kind === 'existing_table'
          ? target
          : {
              kind: 'new_document',
              path: destinationPath.trim(),
              tableTitle: destinationPath.split('/').pop()?.replace(/\.kitable$/i, '') || 'Imported table',
            },
        writeMode,
      })
      await onCompleted(completed.result)
      onOpenChange(false)
    } catch (requestError) {
      if ((requestError as Error)?.name !== 'AbortError') {
        setError(requestError instanceof Error ? requestError.message : t('fileImport.importFailed'))
      }
    } finally {
      abortControllerRef.current = null
      setRunning(false)
    }
  }

  async function handleCancel() {
    abortControllerRef.current?.abort()
    await cancelPreparedTableFileImport(job?.id).catch(() => undefined)
    onOpenChange(false)
  }

  const preview = prepared?.preview
  const runtimeImport = prepared?.backend === 'runtime'

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && running) {
        void handleCancel()
        return
      }
      onOpenChange(nextOpen)
    }}>
      <DialogContent size="3xl" fixed>
        <DialogHeader>
          <DialogTitle>{t('fileImport.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="gap-5">
          <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-soft">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileSpreadsheet className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file?.name}</p>
              <p className="text-xs text-muted-foreground">
                {file ? t('fileImport.fileSize', { size: (file.size / 1024).toFixed(1) }) : ''}
              </p>
            </div>
            {prepared ? (
              <span className="rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground">
                {runtimeImport ? t('fileImport.runtimeBackend') : t('fileImport.compatibilityBackend')}
              </span>
            ) : null}
          </div>

          {loading ? (
            <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t('fileImport.preparingPreview')}
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {preview && !loading ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  [t('fileImport.format'), preview.format.toUpperCase()],
                  [t('fileImport.rows'), preview.row_count.toLocaleString()],
                  [t('fileImport.fields'), preview.field_count.toLocaleString()],
                  [t('fileImport.sheet'), preview.selected_sheet || t('fileImport.notApplicable')],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border bg-card p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 truncate text-sm font-medium">{value}</p>
                  </div>
                ))}
              </div>

              {preview.sheets.length > 1 ? (
                <label className="grid gap-1.5 text-sm sm:max-w-xs">
                  <span className="font-medium">{t('fileImport.selectSheet')}</span>
                  <Select value={selectedSheet} onChange={(event) => setSelectedSheet(event.target.value)} disabled={running}>
                    {preview.sheets.filter((sheet) => !sheet.hidden).map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} ({sheet.row_count.toLocaleString()} {t('fileImport.rows').toLocaleLowerCase()})
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}

              {target.kind === 'new_document' ? (
                <label className="grid gap-1.5 text-sm sm:max-w-md">
                  <span className="font-medium">{t('fileImport.destinationPath')}</span>
                  <Input
                    value={destinationPath}
                    onChange={(event) => setDestinationPath(event.target.value)}
                    disabled={running}
                    placeholder={t('fileImport.destinationPathPlaceholder')}
                  />
                </label>
              ) : null}

              {target.kind === 'existing_table' ? (
                runtimeImport ? (
                  <label className="grid gap-1.5 text-sm sm:max-w-xs">
                    <span className="font-medium">{t('fileImport.writeMode')}</span>
                    <Select value={writeMode} onChange={(event) => setWriteMode(event.target.value as DataImportWriteMode)} disabled={running}>
                      <option value="append">{t('fileImport.append')}</option>
                      <option value="replace">{t('fileImport.replace')}</option>
                    </Select>
                  </label>
                ) : (
                  <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                    {t('fileImport.compatibilityNote')}
                  </p>
                )
              ) : null}

              <section className="grid gap-2">
                <h3 className="text-sm font-medium">{t('fileImport.fieldMapping')}</h3>
                <div className="max-h-64 overflow-auto rounded-xl border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 bg-muted/95 text-left text-xs text-muted-foreground backdrop-blur">
                      <tr>
                        <th className="border-b px-3 py-2 font-medium">{t('fileImport.fieldName')}</th>
                        <th className="w-48 border-b px-3 py-2 font-medium">{t('fileImport.fieldType')}</th>
                        <th className="border-b px-3 py-2 font-medium">{t('fileImport.sample')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.fields.map((field, index) => (
                        <tr key={`${field.index}-${field.title}`} className="border-b last:border-b-0">
                          <td className="px-3 py-2 font-medium">{field.title}</td>
                          <td className="px-3 py-2">
                            <Select
                              value={fieldTypes[index] || field.type}
                              onChange={(event) => setFieldTypes((current) => current.map((value, currentIndex) => (
                                currentIndex === index ? event.target.value as DataImportField['type'] : value
                              )))}
                              disabled={running}
                              aria-label={t('fileImport.fieldTypeFor', { field: field.title })}
                            >
                              {IMPORT_FIELD_TYPES.map((type) => (
                                <option key={type} value={type}>{t(`fileImport.types.${type}`)}</option>
                              ))}
                            </Select>
                          </td>
                          <td className="max-w-80 truncate px-3 py-2 text-muted-foreground">
                            {field.sample_values.slice(0, 3).map(displayCellValue).filter(Boolean).join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {preview.warnings.length ? (
                <section className="grid gap-2">
                  <h3 className="text-sm font-medium">{t('fileImport.warnings')}</h3>
                  <div className="grid gap-2">
                    {preview.warnings.map((warning, index) => (
                      <div key={`${warning.code}-${index}`} className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                        <span>{warning.message}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {running ? (
                <section className="grid gap-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{job ? t(`fileImport.stages.${job.stage}`) : t('fileImport.starting')}</span>
                    <span>{progressPercent}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void handleCancel()}>
            {t('fileImport.cancel')}
          </Button>
          <Button onClick={() => void handleImport()} disabled={!prepared || loading || running || Boolean(error) || (target.kind === 'new_document' && !destinationPath.trim())}>
            {running ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {running ? t('fileImport.importing') : t('fileImport.import')}
          </Button>
        </DialogFooter>
        <DialogClose disabled={running} />
      </DialogContent>
    </Dialog>
  )
}
