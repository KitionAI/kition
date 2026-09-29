import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'
import { importDesignImage } from '../lib/designAssets'
import {
  copyDesignImage,
  DesignExportError,
  exportDesignPDF,
  renderDesignImage,
  renderDesignSVG,
  saveDesignImage,
} from '../lib/designExport'
import { exportBackground, type DesignExportPresets } from '../lib/designExportPresets'
import { requestInsertDesignIntoDocument, requestSendDesignToTable } from '@/services/workspaceDesignActions'
import type { DesignSession } from '../lib/designSession'
import type { DesignStore } from '../lib/designStore'
import type { DesignAsset } from '../lib/designTypes'
import { designVariantList, resolveDesignVariant } from '../lib/designVariants'

export type DesignExportFormat = 'png' | 'jpeg' | 'svg' | 'pdf' | 'copy' | 'all'

/** Importing an image file into the design and exporting the artboard. */
export function useDesignFileActions({
  session,
  store,
  title,
  insertAsset,
  focusCanvas,
  isActive,
  setBusy,
  presets,
}: {
  session: DesignSession
  store: DesignStore
  title: string
  insertAsset: (asset: DesignAsset) => void
  focusCanvas: () => void
  isActive: MutableRefObject<boolean>
  setBusy: Dispatch<SetStateAction<boolean>>
  presets: DesignExportPresets
}) {
  const { t } = useTranslation('design')
  async function importImage(blob: Blob) {
    setBusy(true)
    try {
      const asset = await importDesignImage(session.root, blob)
      if (isActive.current) {
        insertAsset(asset)
        focusCanvas()
      }
    } catch (error) {
      notify.error(t('errors.image'), { description: String(error) })
    } finally {
      setBusy(false)
    }
  }
  /** Every artboard size as its own PNG, named after the variant. */
  async function exportAllVariants() {
    setBusy(true)
    try {
      const base = structuredClone(store.getSnapshot().document)
      for (const entry of designVariantList(base)) {
        const blob = await renderDesignImage(
          resolveDesignVariant(base, entry.id),
          session.root,
          'png',
          presets.scale,
          exportBackground(presets),
        )
        await saveDesignImage(blob, `${title}${entry.name ? ` - ${entry.name}` : ''}.png`, t('export'))
      }
    } catch (error) {
      notify.error(t('errors.export'), {
        description: error instanceof DesignExportError ? t(`errors.${error.code}`) : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  async function exportImage(format: DesignExportFormat) {
    if (format === 'all') return exportAllVariants()
    setBusy(true)
    try {
      const frozen = structuredClone(store.getSnapshot().view)
      const options = { scale: presets.scale, background: exportBackground(presets) }
      if (format === 'pdf') {
        await exportDesignPDF(frozen, session.root, { ...options, filename: `${title}.pdf`, dialogTitle: t('export') })
      } else if (format === 'svg') {
        await saveDesignImage(await renderDesignSVG(frozen, session.root, options), `${title}.svg`, t('export'))
      } else {
        const blob = await renderDesignImage(
          frozen,
          session.root,
          format === 'jpeg' ? 'jpeg' : 'png',
          options.scale,
          options.background,
        )
        if (format === 'copy') {
          await copyDesignImage(blob)
          notify.success(t('copied'))
        } else await saveDesignImage(blob, `${title}.${format === 'jpeg' ? 'jpg' : 'png'}`, t('export'))
      }
    } catch (error) {
      notify.error(t('errors.export'), {
        description: error instanceof DesignExportError ? t(`errors.${error.code}`) : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  /** Exports a PNG into the workspace and hands it to a document or the source record. */
  async function handoff(kind: 'document' | 'table') {
    setBusy(true)
    try {
      const snapshot = store.getSnapshot()
      const frozen = structuredClone(snapshot.view)
      const blob = await renderDesignImage(frozen, session.root, 'png', presets.scale, exportBackground(presets))
      if (kind === 'table') {
        const ref = snapshot.document.provenance?.recordRef
        if (!ref) throw new Error('This design was not created from a table record')
        requestSendDesignToTable({ file: new File([blob], `${title}.png`, { type: 'image/png' }), ref })
        return
      }
      const asset = await importDesignImage(session.root, blob)
      requestInsertDesignIntoDocument({ assetPath: asset.path, title })
    } catch (error) {
      notify.error(t('errors.export'), {
        description: error instanceof DesignExportError ? t(`errors.${error.code}`) : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  return { importImage, exportImage, handoff }
}
