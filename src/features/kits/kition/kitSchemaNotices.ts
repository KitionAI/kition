import { documentSchemaNotice, setDocumentSchemaNotice } from '@/services/documentSchema'
import type { KitHostHandlers } from '@kition/sdk/host'

/**
 * The newer-kit notice of one kit editor (Kit UI protocol section 7f, Kition platform rule M5a):
 * when the kit reports that a newer kit edited its document, the document's notice
 * (`@/services/documentSchema`) offers the update and never blocks editing. `detach` takes back
 * the notice this kit reported when it closes.
 */
export function kitSchemaNotices(path: string, kitId: string) {
  let reported = false
  const handlers: Pick<KitHostHandlers, 'schema'> = {
    schema: ({ reads, newestAuthor }) => {
      reported = true
      setDocumentSchemaNotice(path, { kit: kitId, reads, needs: newestAuthor })
    },
  }
  const detach = () => {
    if (reported && documentSchemaNotice(path)) setDocumentSchemaNotice(path, null)
    reported = false
  }
  return { handlers, detach }
}
