import {
  createBoardElementRecord,
  type BoardElementRecord,
} from './boardRecords'
import {
  BoardStore,
  type BoardRecordDiff,
  type BoardTransaction,
} from './boardStore'
import type { WhiteboardElement } from './whiteboardTypes'

export type BoardCommand =
  | {
      type: 'element.create'
      elements: WhiteboardElement[]
    }
  | {
      type: 'element.update'
      elements: WhiteboardElement[]
    }
  | {
      type: 'element.delete'
      elementIds: string[]
    }

const BOARD_COMMAND_LABELS: Record<BoardCommand['type'], string> = {
  'element.create': 'Create element',
  'element.update': 'Update element',
  'element.delete': 'Delete element',
}

export class BoardCommandRegistry {
  constructor(private store: BoardStore) {}

  execute(command: BoardCommand): BoardRecordDiff | null {
    return this.store.transact(
      BOARD_COMMAND_LABELS[command.type],
      (transaction) => applyBoardCommand(this.store, transaction, command),
    )
  }

  beginElementUpdate(label = 'Update element') {
    return new BoardElementUpdateSession(
      this.store,
      this.store.beginTransaction(label, { live: true }),
    )
  }

  applyAgentDiff(label: string, diff: BoardRecordDiff) {
    return this.store.transact(label, (transaction) => {
      for (const record of diff.added) {
        if (this.store.getRecord(record.id)) {
          throw new Error(`Board record already exists: ${record.id}`)
        }
        transaction.put(record)
      }
      for (const update of diff.updated) {
        const current = this.store.getRecord(update.before.id)
        if (!current || !boardRecordMatches(current, update.before)) {
          throw new Error(`Board changed while the AI preview was open: ${update.before.id}`)
        }
        transaction.put(update.after)
      }
      for (const record of diff.removed) {
        const current = this.store.getRecord(record.id)
        if (!current || !boardRecordMatches(current, record)) {
          throw new Error(`Board changed while the AI preview was open: ${record.id}`)
        }
        transaction.remove(record.id)
      }
    }, { source: 'agent' })
  }
}

export class BoardElementUpdateSession {
  constructor(
    private store: BoardStore,
    private transaction: BoardTransaction,
  ) {}

  update(elements: readonly WhiteboardElement[]) {
    for (const element of elements) {
      const record = this.store.getElementRecord(element.id)
      if (!record) continue
      this.transaction.put(updateElementRecord(record, element))
    }
    return this
  }

  commit() {
    return this.transaction.commit()
  }

  cancel() {
    return this.transaction.cancel()
  }
}

function applyBoardCommand(
  store: BoardStore,
  transaction: BoardTransaction,
  command: BoardCommand,
) {
  switch (command.type) {
    case 'element.create': {
      const pageId = store.getCurrentPageId()
      let index = store.getNextElementIndex(pageId)
      for (const element of command.elements) {
        transaction.put(createBoardElementRecord({ element, index, pageId }))
        index += 1
      }
      break
    }
    case 'element.update':
      for (const element of command.elements) {
        const record = store.getElementRecord(element.id)
        if (record) transaction.put(updateElementRecord(record, element))
      }
      break
    case 'element.delete':
      for (const id of command.elementIds) transaction.remove(id)
      break
  }
}

function updateElementRecord(
  record: BoardElementRecord,
  element: WhiteboardElement,
) {
  return createBoardElementRecord({
    element,
    index: record.index,
    pageId: record.page_id,
  })
}

function boardRecordMatches(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
