/**
 * The `.kitable` files open in a table editor in this window, by workspace path, for what follows
 * open documents (co-editing). Several tabs on one file announce it once.
 */
import { createOpenDocumentRegistry } from '@/lib/openDocuments'

export type OpenTable = { path: string }

const tables = createOpenDocumentRegistry<OpenTable>()

export const registerOpenTable = tables.register
export const followOpenTables = tables.follow
export const findOpenTable = tables.find
