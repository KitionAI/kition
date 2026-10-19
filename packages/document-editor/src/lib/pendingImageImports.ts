import { imageImportFailure, type ImageImportFailure } from './imageImportError'
import { importDocumentClipboardImages, type DocumentClipboardImage } from './documentImagePaste'

const PREFIX = 'attachments/.pending-image-'
const STORAGE_PREFIX = 'kition.pending-image.'
type PendingImage = {
  image: DocumentClipboardImage
  documentPath: string
  reason: ImageImportFailure
  destination?: string
  running?: Promise<string>
}
const pending = new Map<string, PendingImage>()

function persist(id: string, job: PendingImage) {
  try {
    // Remote retry metadata stays on this device; it is never a document image URL.
    // Drop the signed source as soon as a local attachment has been saved.
    if (job.destination) localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ destination: job.destination }))
    else if (job.image.kind === 'source' && /^https?:\/\//i.test(job.image.source)) {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ image: job.image, documentPath: job.documentPath, reason: job.reason }))
    }
  } catch { /* The in-memory job remains usable if local storage is unavailable. */ }
}

function read(id: string): PendingImage | undefined {
  if (pending.has(id)) return pending.get(id)
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || 'null')
    if (typeof saved?.destination === 'string' && /^(?:\.\.\/)*attachments\//.test(saved.destination)
      && !/[\\?#<>"\p{Cc}]/u.test(saved.destination)
      && !saved.destination.replace(/^(?:\.\.\/)*/, '').split('/').some((part: string) => !part || part === '..' || part === '.')) {
      return { image: { kind: 'source', source: '', alt: 'image' }, documentPath: '', reason: 'download', destination: saved.destination }
    }
    if (saved?.image?.kind === 'source' && typeof saved.image.source === 'string'
      && /^https?:\/\//i.test(saved.image.source) && typeof saved.documentPath === 'string') {
      const job: PendingImage = { image: saved.image, documentPath: saved.documentPath, reason: saved.reason || 'download' }
      pending.set(id, job)
      return job
    }
  } catch { /* Invalid local retry metadata cannot prevent a document from opening. */ }
}

export function pendingImageId(source: string) {
  return source.startsWith(PREFIX) && /^[\da-f-]+$/i.test(source.slice(PREFIX.length)) ? source.slice(PREFIX.length) : null
}

export function deferImageImport(image: DocumentClipboardImage, documentPath: string, error: unknown) {
  const id = crypto.randomUUID()
  const job: PendingImage = { image, documentPath, reason: imageImportFailure(error) }
  pending.set(id, job)
  persist(id, job)
  const alt = image.alt.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
  return `![${alt}](${PREFIX}${id})`
}

export function pendingImageStatus(id: string) {
  const job = read(id)
  return { available: Boolean(job), reason: job?.reason || 'download', destination: job?.destination }
}

export async function retryPendingImage(id: string, documentPath: string): Promise<string> {
  const job = read(id)
  if (!job) throw new Error('image retry is unavailable')
  if (job.destination) return job.destination
  if (job.running) return job.running
  job.running = (async () => {
    try {
      const [markdown] = await importDocumentClipboardImages([job.image], { documentPath })
      const destination = markdown.slice(markdown.lastIndexOf('](') + 2, -1).replace(/^<|>$/g, '')
      job.destination = destination.replace(/[\s"<>()]/g, (character) =>
        character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character),
      )
      job.image = { kind: 'source', source: '', alt: 'image' }
      persist(id, job)
      return job.destination
    } catch (error) {
      job.reason = imageImportFailure(error)
      persist(id, job)
      throw error
    } finally { job.running = undefined }
  })()
  return job.running
}
