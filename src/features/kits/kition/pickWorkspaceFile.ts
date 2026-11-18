import { chooseFilesToImport, getDesktopBridge, importWorkspaceFile, uint8ArrayToBase64 } from '@/services/desktop'

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/** A browser file chooser; answers the chosen file, or null when the person cancels. */
function chooseInPage(accept: string[]) {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept.map((extension) => `.${extension}`).join(',')
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/**
 * A kit's `host/pick` (Kit UI protocol): the person chooses a file, and Kition copies it into the
 * workspace next to the document, so the kit reads it like any workspace file. Answers its
 * workspace path, or null when the person cancels. The desktop's own chooser is used when there
 * is one: it needs no click in this page, which the kit's frame cannot lend.
 */
export async function pickWorkspaceFile(documentPath: string, accept: string[]) {
  const folder = documentPath.includes('/') ? documentPath.slice(0, documentPath.lastIndexOf('/')) : ''
  const wanted = (name: string) => !accept.length || accept.includes(extensionOf(name))
  if (getDesktopBridge()?.ChooseFilesToImport) {
    const chosen = await chooseFilesToImport()
    const source = chosen.canceled ? undefined : chosen.paths.find(wanted)
    if (!source) return null
    const filename = source.replace(/\\/g, '/').split('/').pop() ?? source
    const imported = await importWorkspaceFile({ folder, filename, source_path: source })
    return imported?.imported_path ?? null
  }
  const file = await chooseInPage(accept)
  if (!file || !wanted(file.name)) return null
  const imported = await importWorkspaceFile({ folder, filename: file.name, base64_content: uint8ArrayToBase64(new Uint8Array(await file.arrayBuffer())) })
  return imported?.imported_path ?? null
}
