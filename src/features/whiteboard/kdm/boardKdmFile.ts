import { newDocId, Replica, system } from '@/lib/kdm'
import { boardSchema } from './boardSchema'

/**
 * A new board document: the `Board` root titled `title` and one page. The ids default to new KDM
 * ids; tests and fixtures may choose them.
 */
export function createEmptyBoard(
  title: string,
  actor: bigint,
  ids: { rootId?: string; pageId?: string } = {},
): Replica {
  return Replica.createWith(boardSchema, newDocId(), actor, system('create'), (tx) => {
    const page = tx.create('Page', { name: title || 'Page 1' }, ids.pageId === undefined ? undefined : { id: ids.pageId })
    const root = tx.create('Board', { title }, ids.rootId === undefined ? undefined : { id: ids.rootId })
    tx.listInsert(root, 'pages', 0, page)
  }).replica
}
