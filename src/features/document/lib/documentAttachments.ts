/** Mirror the full note path so identically named notes never share an asset folder. */
export function documentAttachmentFolder(documentPath: string) {
  const path = documentPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..' || /[\p{Cc}:]/u.test(segment))) {
    throw new Error('attachments require a workspace-relative document path')
  }
  return `attachments/${segments.length ? segments.join('/') : '_unfiled'}`
}
