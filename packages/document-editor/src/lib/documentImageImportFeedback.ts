import i18next from 'i18next'
import { notifyDocument } from '../host'
import { imageImportFailure } from './imageImportError'

export function notifyImageImportFailure(error?: unknown) {
  notifyDocument('error', i18next.t(`editor.image.importErrors.${imageImportFailure(error)}`, { ns: 'document' }))
}
