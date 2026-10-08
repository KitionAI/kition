import i18next from 'i18next'
import { notify } from '@/lib/notify'
import { imageImportFailure } from '@/lib/imageImportError'

export function notifyImageImportFailure(error?: unknown) {
  notify.error(i18next.t(`editor.image.importErrors.${imageImportFailure(error)}`, { ns: 'document' }))
}
