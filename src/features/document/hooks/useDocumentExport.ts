import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'
import { inlineMermaidBlocksInHtml } from '@/services/mermaid'
import {
  isDesktopRuntime,
  saveBinaryFile,
  savePdfFile,
  saveTextFile,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
} from '@/services/desktop'
import { resolveWorkspaceImageSources } from '@/services/workspaceFiles'

export type DocumentExportFormat = 'markdown' | 'html' | 'pdf' | 'word'

export type DocumentExportPageFormat = 'a4' | 'a3' | 'a5' | 'letter' | 'legal' | 'tabloid'

export type DocumentExportMarginsType = 0 | 1 | 2

export const documentExportFormats: Array<{
  value: DocumentExportFormat
  label: string
  extension: string
}> = [
  { value: 'markdown', label: 'Markdown (.md)', extension: 'md' },
  { value: 'html', label: 'HTML (.html)', extension: 'html' },
  { value: 'pdf', label: 'PDF (.pdf)', extension: 'pdf' },
  { value: 'word', label: 'Word (.docx)', extension: 'docx' },
]

export const documentExportPageFormats: Array<{ value: DocumentExportPageFormat; label: string }> = [
  { value: 'a4', label: 'A4' },
  { value: 'a3', label: 'A3' },
  { value: 'a5', label: 'A5' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'tabloid', label: 'Tabloid' },
]

export const documentExportMarginsOptions: Array<{ value: DocumentExportMarginsType; label: string }> = [
  { value: 0, label: 'Default' },
  { value: 1, label: 'None' },
  { value: 2, label: 'Minimum' },
]

function getDocumentExportFilename(title: string, extension: string) {
  const safeTitle = (title || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled'
  return `${safeTitle}.${extension}`
}

function downloadBrowserBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.URL.revokeObjectURL(url)
}

function downloadBrowserText(content: string, filename: string, mimeType: string) {
  downloadBrowserBlob(new Blob([content], { type: `${mimeType};charset=utf-8` }), filename)
}

async function saveTextExport(filename: string, content: string, mimeType: string, dialogTitle: string) {
  if (isDesktopRuntime()) {
    return saveTextFile({ dialogTitle, defaultFilename: filename, content })
  }

  downloadBrowserText(content, filename, mimeType)
  return filename
}

async function saveBinaryExport(filename: string, bytes: Uint8Array, mimeType: string, dialogTitle: string) {
  if (isDesktopRuntime()) {
    return saveBinaryFile({ dialogTitle, defaultFilename: filename, bytes })
  }

  downloadBrowserBlob(new Blob([bytes as BlobPart], { type: mimeType }), filename)
  return filename
}

type UseDocumentExportOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  draftContent: string
  onError: (message: string) => void
  onFeedback: (message: string) => void
}

export function useDocumentExport({
  activeDocument,
  draftContent,
  onError,
  onFeedback,
}: UseDocumentExportOptions) {
  const { t } = useTranslation('document')
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<DocumentExportFormat>('markdown')
  const [exportIncludeMedia, setExportIncludeMedia] = useState(true)
  const [exportPageFormat, setExportPageFormat] = useState<DocumentExportPageFormat>('a4')
  const [exportScale, setExportScale] = useState('100')
  const [pdfIncludeName, setPdfIncludeName] = useState(false)
  const [pdfLandscape, setPdfLandscape] = useState(false)
  const [pdfMarginsType, setPdfMarginsType] = useState<DocumentExportMarginsType>(0)
  const [exporting, setExporting] = useState(false)

  function openExportDialog() {
    if (!activeDocument) {
      return
    }

    setExportDialogOpen(true)
    onError('')
    onFeedback('')
  }

  async function exportCurrentDocument() {
    if (!activeDocument || exporting) {
      return
    }

    setExporting(true)
    onError('')
    onFeedback('')

    try {
      const title = getWorkspaceItemTitle(activeDocument.name)
      const formatOption = documentExportFormats.find((item) => item.value === exportFormat) || documentExportFormats[0]
      const filename = getDocumentExportFilename(title, formatOption.extension)

      if (exportFormat === 'markdown') {
        const savedPath = await saveTextExport(filename, draftContent, 'text/markdown', t('export.dialogTitle.markdown'))
        onFeedback(savedPath ? t('export.feedback.markdownExported') : t('export.feedback.canceled'))
        setExportDialogOpen(false)
        return
      }

      if (exportFormat === 'html') {
        const { markdownToHtml } = await import('@/services/markdownRenderer')
        const bodyHtml = await inlineMermaidBlocksInHtml(
          resolveWorkspaceImageSources(markdownToHtml(draftContent), activeDocument.path),
        )
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${bodyHtml}</body></html>`
        const savedPath = await saveTextExport(filename, html, 'text/html', t('export.dialogTitle.html'))
        onFeedback(savedPath ? t('export.feedback.htmlExported') : t('export.feedback.canceled'))
        setExportDialogOpen(false)
        return
      }

      if (exportFormat === 'pdf') {
        const scaleNumber = Number(exportScale)
        if (!Number.isFinite(scaleNumber) || scaleNumber < 10 || scaleNumber > 100) {
          onError(t('export.scaleError'))
          return
        }
        const { markdownToHtml } = await import('@/services/markdownRenderer')
        const bodyHtml = await inlineMermaidBlocksInHtml(
          resolveWorkspaceImageSources(markdownToHtml(draftContent), activeDocument.path),
        )
        const { buildPdfExportHtml } = await import('@/features/document/lib/pdfExportHtml')
        const html = buildPdfExportHtml({
          title,
          bodyHtml,
          includeName: pdfIncludeName,
          pageFormat: exportPageFormat,
          landscape: pdfLandscape,
        })

        if (!isDesktopRuntime()) {
          onError(t('export.pdfDesktopOnly'))
          return
        }

        const savedPath = await savePdfFile({
          dialogTitle: t('export.dialogTitle.pdf'),
          defaultFilename: filename,
          html,
          pageFormat: exportPageFormat,
          documentPath: activeDocument.path,
          landscape: pdfLandscape,
          marginsType: pdfMarginsType,
          scaleFactor: scaleNumber,
        })
        onFeedback(savedPath ? t('export.feedback.pdfExportedTo', { path: savedPath }) : t('export.feedback.canceled'))
        setExportDialogOpen(false)
        return
      }

      if (exportFormat === 'word') {
        const { buildWordExportBlob } = await import('@/features/document/lib/docxExport')
        const blob = await buildWordExportBlob({
          markdown: draftContent,
          title,
          includeMedia: exportIncludeMedia,
          includeName: true,
        })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const savedPath = await saveBinaryExport(
          filename,
          bytes,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          t('export.dialogTitle.word'),
        )
        onFeedback(savedPath ? t('export.feedback.wordExportedTo', { path: savedPath }) : t('export.feedback.canceled'))
        setExportDialogOpen(false)
        return
      }
    } catch (requestError: any) {
      onError(requestError?.message || t('export.feedback.failed'))
    } finally {
      setExporting(false)
    }
  }

  return {
    exportCurrentDocument,
    exportDialogOpen,
    exportFormat,
    exportIncludeMedia,
    exportPageFormat,
    exportScale,
    exporting,
    openExportDialog,
    pdfIncludeName,
    pdfLandscape,
    pdfMarginsType,
    setExportDialogOpen,
    setExportFormat,
    setExportIncludeMedia,
    setExportPageFormat,
    setExportScale,
    setPdfIncludeName,
    setPdfLandscape,
    setPdfMarginsType,
  }
}
