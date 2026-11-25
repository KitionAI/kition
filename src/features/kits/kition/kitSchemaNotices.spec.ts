import { describe, expect, it } from 'vitest'
import { documentSchemaNotice } from '@/services/documentSchema'
import { kitSchemaNotices } from './kitSchemaNotices'

describe('kitSchemaNotices (Kit UI protocol section 7f)', () => {
  it("shows a notice when the kit reports a newer kit's edits, and takes it back when the kit closes", () => {
    const path = 'Newer.kslide'
    const { handlers, detach } = kitSchemaNotices(path, 'kit.slide')
    handlers.schema?.({ reads: 2, newestAuthor: 3 })
    expect(documentSchemaNotice(path)).toEqual({ kit: 'kit.slide', reads: 2, needs: 3 })
    detach()
    expect(documentSchemaNotice(path)).toBeNull()
  })
})
