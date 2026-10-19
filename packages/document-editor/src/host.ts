/**
 * What the Markdown document editor asks of the app it runs in. Every member is optional: a missing
 * one hides or skips what needs it (pasted and dropped images stay links to where they came from,
 * Copy image is not offered, wikilink previews say the note is not found), and images show only
 * URLs that load by themselves. Kition's implementation is src/features/document/host; the
 * Document kit's is in packages/document-kit/web.
 *
 * The editor's CodeMirror extensions run outside React, so the host is set once for the page
 * (`setDocumentHost`) before an editor mounts, rather than provided through a React context.
 */

/** Where an imported image was kept: its path in the app's files, and that path relative to the folder asked for. */
type DocumentImportedImage = { importedPath: string; relativePath: string }

/** Keeps images a person pasted or dropped into a document as files of the app (attachments). */
type DocumentImageImport = {
  /** Keeps an image file in `folder`; `index` numbers the images of one paste. */
  fromFile: (options: { file: File; folder: string; index: number }) => Promise<DocumentImportedImage>
  /** Keeps the image at `blobURL` (an `http(s):`, `data:`, or `blob:` URL) in `folder`. */
  fromURL: (options: { blobURL: string; folder: string; index: number }) => Promise<DocumentImportedImage>
  /** Whether the app reads a bitmap from the system clipboard itself (a desktop shell). */
  canReadClipboard?: () => boolean
  /** Keeps the clipboard's bitmap in `folder`; `null` when there is none. */
  fromClipboard?: (options: { folder: string; index: number }) => Promise<DocumentImportedImage | null>
}

export type DocumentNotice = { description?: string }

export type DocumentHost = {
  /**
   * The URL an image shows: `source` as written in the document at `documentPath` (relative to its
   * folder, or a path in the app's files). Answer an empty string for an image that cannot show.
   */
  resolveImageURL?: (source: string, documentPath: string) => string
  /** The app's Markdown files by path, for wikilink previews. */
  listMarkdownFiles?: () => Promise<string[]>
  /** The text of a file of the app, for wikilink previews. */
  readTextFile?: (path: string) => Promise<string>
  /** Keeps pasted and dropped images as files; without it they stay links to where they came from. */
  images?: DocumentImageImport
  /** Copies the image at `source` (as the editor shows it) to the clipboard. */
  copyImage?: (source: string) => Promise<unknown>
  /** Tells the person something happened; silent without it. */
  notify?: (kind: 'success' | 'error', message: string, options?: DocumentNotice) => void
}

let current: DocumentHost = {}

/** Sets what the document editors of this page ask of their app (once, before the first editor mounts). */
export function setDocumentHost(host: DocumentHost) {
  current = host
}

/** The document editors' host (`setDocumentHost`); empty until one is set. */
export function documentHost(): DocumentHost {
  return current
}

const SELF_CONTAINED_URL = /^(https?:|data:|blob:)/i

/** `source` without the angle brackets a Markdown destination may wrap it in. */
function unwrapDestination(source: string | undefined) {
  const raw = String(source || '').trim()
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw
}

/** The URL an image written as `source` in the document at `documentPath` shows: the host's, or the URL itself when it loads by itself. */
export function documentImageURL(source: string | undefined, documentPath: string) {
  const resolve = current.resolveImageURL
  if (resolve) return resolve(source ?? '', documentPath)
  const raw = unwrapDestination(source)
  return SELF_CONTAINED_URL.test(raw) ? raw : ''
}

/** Whether `path` names an image file of the app (not a URL): an embed such as `![[photo.png]]`. */
export function isLocalImagePath(path: string) {
  const raw = unwrapDestination(path)
  if (!raw || /^(https?:|data:|blob:|file:|kition-workspace:|\/)/i.test(raw)) return false
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(raw.split(/[?#]/)[0])
}

/** Says something to the person through the host, if it listens. */
export function notifyDocument(kind: 'success' | 'error', message: string, options?: DocumentNotice) {
  current.notify?.(kind, message, options)
}
