export type ImageImportFailure = 'desktopUpdate' | 'accessDenied' | 'notImage' | 'tooLarge' | 'download' | 'write'

export class ImageImportError extends Error {
  constructor(readonly reason: ImageImportFailure, cause?: unknown) {
    super(`Image import failed: ${reason}`, { cause })
  }
}

/** Never expose signed URLs, credentials, or filesystem paths in user messages. */
export function imageImportFailure(error: unknown): ImageImportFailure {
  if (error instanceof ImageImportError) return error.reason
  const message = error instanceof Error ? error.message : ''
  if (/No handler registered|IMAGE_IMPORT_DESKTOP_UPDATE_REQUIRED/i.test(message)) return 'desktopUpdate'
  if (/\b(?:401|403)\b/.test(message)) return 'accessDenied'
  if (/not an image/i.test(message)) return 'notImage'
  if (/50 MB|too large/i.test(message)) return 'tooLarge'
  if (/EACCES|EPERM|ENOSPC|not saved|no local path/i.test(message)) return 'write'
  if (error instanceof Error && error.cause) return imageImportFailure(error.cause)
  return 'download'
}
