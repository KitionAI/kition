import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'
import { importDesignImage } from '../lib/designAssets'
import {
  copyDesignImage,
  DesignExportError,
  renderDesignImage,
  saveDesignImage,
} from '../lib/designExport'
import type { DesignSession } from '../lib/designSession'
import type { DesignStore } from '../lib/designStore'
import type { DesignAsset } from '../lib/designTypes'
import { designVariantList, resolveDesignVariant } from '../lib/designVariants'

/** Importing an image file into the design and exporting the artboard. */
export function useDesignFileActions({
  session,
  store,
  title,
  insertAsset,
  focusCanvas,
  isActive,
  setBusy,
}: {
  session: DesignSession
  store: DesignStore
  title: string
  insertAsset: (asset: DesignAsset) => void
  focusCanvas: () => void
  isActive: MutableRefObject<boolean>
  setBusy: Dispatch<SetStateAction<boolean>>
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
        const blob = await renderDesignImage(resolveDesignVariant(base, entry.id), session.root, 'png')
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
  async function exportImage(format: 'png' | 'jpeg' | 'copy' | 'all') {
    if (format === 'all') return exportAllVariants()
    setBusy(true)
    try {
      const frozen = structuredClone(store.getSnapshot().view),
        blob = await renderDesignImage(
          frozen,
          session.root,
          format === 'jpeg' ? 'jpeg' : 'png',
        )
      if (format === 'copy') {
        await copyDesignImage(blob)
        notify.success(t('copied'))
      } else
        await saveDesignImage(
          blob,
          `${title}.${format === 'jpeg' ? 'jpg' : 'png'}`,
          t('export'),
        )
    } catch (error) {
      notify.error(t('errors.export'), {
        description:
          error instanceof DesignExportError
            ? t(`errors.${error.code}`)
            : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  return { importImage, exportImage }
}
