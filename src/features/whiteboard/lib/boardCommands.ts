import {
  createBoardConnectorBindingRecord,
  removeBoardConnectorBindings,
  syncBoardConnectorBindings,
  type BoardConnectorAnchor,
  type BoardConnectorTerminal,
} from './boardBindingEngine'
import {
  BOARD_META_RECORD_ID,
  createBoardElementRecord,
  boardElementFromRecord,
  cloneBoardRecord,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardMetaRecord,
  type BoardPageRecord,
} from './boardRecords'
import { instantiateBoardClipboardRecords } from './boardClipboard'
import {
  getBoardElementsWithDescendants,
  getBoardSelectionRootIds,
  isBoardContainerElement,
  type BoardContainerKind,
} from './boardHierarchy'
import {
  BoardStore,
  type BoardRecordDiff,
  type BoardTransaction,
} from './boardStore'
import { getWhiteboardSelectionBounds } from './whiteboardGeometry'
import type { WhiteboardElement } from './whiteboardTypes'

export type BoardElementReorderPlacement =
  | 'front'
  | 'forward'
  | 'backward'
  | 'back'

export type BoardPageReorderPlacement = 'previous' | 'next'

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
  | {
      type: 'element.reorder'
      elementIds: string[]
      placement: BoardElementReorderPlacement
    }
  | {
      type: 'connector.create'
      element: Extract<WhiteboardElement, { kind: 'connector' }>
      bindings: Array<{
        anchor: BoardConnectorAnchor
        terminal: BoardConnectorTerminal
      }>
    }
  | {
      type: 'connector.update-terminal'
      connectorId: string
      terminal: BoardConnectorTerminal
      point: { x: number; y: number }
      binding?: BoardConnectorAnchor
    }
  | {
      type: 'element.paste'
      bindings: BoardBindingRecord[]
      elements: WhiteboardElement[]
    }
  | {
      type: 'element.group'
      containerId: string
      containerKind: BoardContainerKind
      elementIds: string[]
    }
  | {
      type: 'element.ungroup'
      containerIds: string[]
    }
  | {
      type: 'page.create'
      pageId: string
      name: string
      activate?: boolean
    }
  | {
      type: 'page.rename'
      pageId: string
      name: string
    }
  | {
      type: 'page.activate'
      pageId: string
    }
  | {
      type: 'page.duplicate'
      sourcePageId: string
      pageId: string
      name: string
    }
  | {
      type: 'page.delete'
      pageId: string
    }
  | {
      type: 'page.reorder'
      pageId: string
      placement: BoardPageReorderPlacement
    }

const BOARD_COMMAND_LABELS: Record<BoardCommand['type'], string> = {
  'element.create': 'Create element',
  'element.update': 'Update element',
  'element.delete': 'Delete element',
  'element.reorder': 'Reorder elements',
  'connector.create': 'Create connector',
  'connector.update-terminal': 'Update connector terminal',
  'element.paste': 'Paste elements',
  'element.group': 'Group elements',
  'element.ungroup': 'Ungroup elements',
  'page.create': 'Create page',
  'page.rename': 'Rename page',
  'page.activate': 'Switch page',
  'page.duplicate': 'Duplicate page',
  'page.delete': 'Delete page',
  'page.reorder': 'Reorder page',
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
    const changedElementIds = new Set<string>()
    for (const element of elements) {
      const record = this.store.getElementRecord(element.id)
      if (!record) continue
      this.transaction.put(updateElementRecord(record, element))
      changedElementIds.add(element.id)
    }
    syncBoardConnectorBindings(this.store, this.transaction, changedElementIds)
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
    case 'element.update': {
      const changedElementIds = new Set<string>()
      for (const element of command.elements) {
        const record = store.getElementRecord(element.id)
        if (record) {
          transaction.put(updateElementRecord(record, element))
          changedElementIds.add(element.id)
        }
      }
      syncBoardConnectorBindings(store, transaction, changedElementIds)
      break
    }
    case 'element.delete': {
      const elementIds = new Set(getBoardElementsWithDescendants(
        store.getCurrentPageElements(),
        command.elementIds,
      ).map((element) => element.id))
      removeBoardConnectorBindings(store, transaction, elementIds)
      for (const id of elementIds) transaction.remove(id)
      break
    }
    case 'element.reorder':
      reorderBoardElements(store, transaction, command.elementIds, command.placement)
      break
    case 'connector.create': {
      const pageId = store.getCurrentPageId()
      transaction.put(createBoardElementRecord({
        element: command.element,
        index: store.getNextElementIndex(pageId),
        pageId,
      }))
      const terminals = new Set<BoardConnectorTerminal>()
      for (const binding of command.bindings) {
        if (terminals.has(binding.terminal)) continue
        if (!store.getElementRecord(binding.anchor.targetElementId)) continue
        terminals.add(binding.terminal)
        transaction.put(createBoardConnectorBindingRecord({
          anchor: binding.anchor,
          connectorId: command.element.id,
          terminal: binding.terminal,
        }))
      }
      break
    }
    case 'connector.update-terminal': {
      const record = store.getElementRecord(command.connectorId)
      if (!record || record.kind !== 'connector' || record.locked) break
      const element = boardElementFromRecord(record)
      if (element.kind !== 'connector') break
      transaction.remove(`binding:${element.id}:${command.terminal}`)
      transaction.put(createBoardElementRecord({
        element: { ...element, [command.terminal]: { ...command.point } },
        index: record.index,
        pageId: record.page_id,
      }))
      if (command.binding && store.getElementRecord(command.binding.targetElementId)) {
        transaction.put(createBoardConnectorBindingRecord({
          anchor: command.binding,
          connectorId: element.id,
          terminal: command.terminal,
        }))
      }
      break
    }
    case 'element.paste': {
      const pageId = store.getCurrentPageId()
      let index = store.getNextElementIndex(pageId)
      for (const element of command.elements) {
        transaction.put(createBoardElementRecord({ element, index, pageId }))
        index += 1
      }
      for (const binding of command.bindings) {
        const connector = store.getElementRecord(binding.from_id)
        const target = store.getElementRecord(binding.to_id)
        if (
          connector?.kind !== 'connector'
          || !target
          || (binding.terminal !== 'start' && binding.terminal !== 'end')
        ) continue
        transaction.put(binding)
      }
      break
    }
    case 'element.group':
      groupBoardElements(store, transaction, command)
      break
    case 'element.ungroup':
      ungroupBoardElements(store, transaction, command.containerIds)
      break
    case 'page.create':
      createBoardPage(store, transaction, command)
      break
    case 'page.rename':
      renameBoardPage(store, transaction, command.pageId, command.name)
      break
    case 'page.activate':
      activateBoardPage(store, transaction, command.pageId)
      break
    case 'page.duplicate':
      duplicateBoardPage(store, transaction, command)
      break
    case 'page.delete':
      deleteBoardPage(store, transaction, command.pageId)
      break
    case 'page.reorder':
      reorderBoardPage(store, transaction, command.pageId, command.placement)
      break
  }
}

function createBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  command: Extract<BoardCommand, { type: 'page.create' }>,
) {
  if (store.getRecord(command.pageId)) return
  const pages = store.getPages()
  transaction.put({
    record_type: 'page',
    id: command.pageId,
    name: normalizePageName(command.name, pages.length + 1),
    index: pages.length,
  })
  if (command.activate !== false) {
    transaction.put(createBoardMetaRecord(command.pageId))
  }
}

function renameBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  pageId: string,
  name: string,
) {
  const page = store.getRecord(pageId)
  if (page?.record_type !== 'page') return
  transaction.put({ ...page, name: normalizePageName(name, page.index + 1) })
}

function activateBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  pageId: string,
) {
  if (store.getRecord(pageId)?.record_type !== 'page') return
  transaction.put(createBoardMetaRecord(pageId))
}

function duplicateBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  command: Extract<BoardCommand, { type: 'page.duplicate' }>,
) {
  const source = store.getRecord(command.sourcePageId)
  if (source?.record_type !== 'page' || store.getRecord(command.pageId)) return
  const pages = store.getPages()
  const sourceRecords = store.getRecords().filter((record) => (
    record.record_type === 'element'
      ? record.page_id === source.id
      : record.record_type === 'binding'
        ? store.getElementRecord(record.from_id)?.page_id === source.id
        : false
  ))
  const cloned = instantiateBoardClipboardRecords(sourceRecords, { x: 0, y: 0 })
  transaction.put({
    record_type: 'page',
    id: command.pageId,
    name: normalizePageName(command.name, pages.length + 1),
    index: source.index + 1,
  })
  for (const page of pages) {
    if (page.index > source.index) transaction.put({ ...page, index: page.index + 1 })
  }
  cloned.elements.forEach((element, index) => transaction.put(createBoardElementRecord({
    element,
    index,
    pageId: command.pageId,
  })))
  cloned.bindings.forEach((binding) => transaction.put(binding))
  transaction.put(createBoardMetaRecord(command.pageId))
}

function deleteBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  pageId: string,
) {
  const pages = store.getPages()
  const page = pages.find((item) => item.id === pageId)
  if (!page || pages.length < 2) return
  const elementIds = new Set(store.getRecords().flatMap((record) => (
    record.record_type === 'element' && record.page_id === pageId ? [record.id] : []
  )))
  removeBoardConnectorBindings(store, transaction, elementIds)
  for (const elementId of elementIds) transaction.remove(elementId)
  transaction.remove(pageId)
  pages
    .filter((item) => item.id !== pageId)
    .sort((left, right) => left.index - right.index)
    .forEach((item, index) => transaction.put({ ...item, index }))
  if (store.getCurrentPageId() === pageId) {
    const fallback = pages.find((item) => item.index > page.index)
      || [...pages].reverse().find((item) => item.index < page.index)
    if (fallback) transaction.put(createBoardMetaRecord(fallback.id))
  }
}

function reorderBoardPage(
  store: BoardStore,
  transaction: BoardTransaction,
  pageId: string,
  placement: BoardPageReorderPlacement,
) {
  const pages = store.getPages().sort((left, right) => left.index - right.index)
  const index = pages.findIndex((page) => page.id === pageId)
  if (index < 0) return
  const targetIndex = placement === 'previous' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= pages.length) return
  const [page] = pages.splice(index, 1)
  pages.splice(targetIndex, 0, page)
  pages.forEach((item, nextIndex) => transaction.put({ ...item, index: nextIndex }))
}

function createBoardMetaRecord(pageId: string): BoardMetaRecord {
  return {
    record_type: 'meta',
    id: BOARD_META_RECORD_ID,
    active_page_id: pageId,
  }
}

function normalizePageName(name: string, fallbackIndex: number) {
  return String(name || '').trim().slice(0, 120) || `Page ${fallbackIndex}`
}

function groupBoardElements(
  store: BoardStore,
  transaction: BoardTransaction,
  command: Extract<BoardCommand, { type: 'element.group' }>,
) {
  const pageId = store.getCurrentPageId()
  const elements = store.getCurrentPageElements()
  const rootIds = getBoardSelectionRootIds(elements, command.elementIds)
  const rootIdSet = new Set(rootIds)
  const roots = elements.filter((element) => rootIdSet.has(element.id) && !element.locked)
  const minimumCount = command.containerKind === 'group' ? 2 : 1
  const bounds = getWhiteboardSelectionBounds(roots)
  if (!bounds || roots.length < minimumCount || store.getRecord(command.containerId)) return

  const commonParentId = roots.every((element) => element.parentId === roots[0].parentId)
    ? roots[0].parentId
    : undefined
  const horizontalPadding = command.containerKind === 'frame' ? 32 : 8
  const topPadding = command.containerKind === 'frame' ? 52 : 8
  const bottomPadding = command.containerKind === 'frame' ? 32 : 8
  const container: Extract<WhiteboardElement, { kind: 'rectangle' }> = {
    id: command.containerId,
    kind: 'rectangle',
    locked: false,
    parentId: commonParentId,
    rotation: 0,
    shapeStyle: command.containerKind,
    shapeType: command.containerKind === 'frame' ? 'frame' : 'rectangle',
    x: bounds.x - horizontalPadding,
    y: bounds.y - topPadding,
    width: bounds.width + horizontalPadding * 2,
    height: bounds.height + topPadding + bottomPadding,
  }
  const pageRecords = store.getRecords().filter((record): record is BoardElementRecord => (
    record.record_type === 'element' && record.page_id === pageId
  ))
  const updatedRoots = new Map(roots.map((element) => {
    const record = store.getElementRecord(element.id)!
    return [element.id, updateElementRecord(record, { ...element, parentId: container.id })]
  }))
  const ordered = pageRecords.map((record) => updatedRoots.get(record.id) || record)
  const insertionIndex = Math.max(0, ordered.findIndex((record) => rootIdSet.has(record.id)))
  ordered.splice(insertionIndex, 0, createBoardElementRecord({
    element: container,
    index: insertionIndex,
    pageId,
  }))
  ordered.forEach((record, index) => transaction.put({ ...record, index }))
}

function ungroupBoardElements(
  store: BoardStore,
  transaction: BoardTransaction,
  containerIds: readonly string[],
) {
  const pageId = store.getCurrentPageId()
  const elements = store.getCurrentPageElements()
  const rootIds = new Set(getBoardSelectionRootIds(elements, containerIds))
  const containers = elements.filter((element) => (
    rootIds.has(element.id) && isBoardContainerElement(element) && !element.locked
  ))
  if (containers.length === 0) return
  const containerIdsToRemove = new Set(containers.map((element) => element.id))
  const parentByContainer = new Map(containers.map((element) => [
    element.id,
    element.parentId,
  ]))
  const pageRecords = store.getRecords().filter((record): record is BoardElementRecord => (
    record.record_type === 'element' && record.page_id === pageId
  ))
  removeBoardConnectorBindings(store, transaction, containerIdsToRemove)
  const remaining = pageRecords.flatMap((record): BoardElementRecord[] => {
    if (containerIdsToRemove.has(record.id)) {
      transaction.remove(record.id)
      return []
    }
    if (!record.parentId || !containerIdsToRemove.has(record.parentId)) return [record]
    return [updateElementRecord(record, {
      ...boardElementFromRecord(record),
      parentId: parentByContainer.get(record.parentId),
    })]
  })
  remaining.forEach((record, index) => transaction.put({ ...record, index }))
}

function reorderBoardElements(
  store: BoardStore,
  transaction: BoardTransaction,
  elementIds: readonly string[],
  placement: BoardElementReorderPlacement,
) {
  const pageId = store.getCurrentPageId()
  const selectedIds = new Set(getBoardElementsWithDescendants(
    store.getCurrentPageElements(),
    elementIds,
  ).map((element) => element.id))
  const records = store.getRecords().filter((record): record is BoardElementRecord => (
    record.record_type === 'element' && record.page_id === pageId
  ))
  if (!records.some((record) => selectedIds.has(record.id))) return

  const reordered = reorderElementRecords(records, selectedIds, placement)
  reordered.forEach((record, index) => {
    if (record.index !== index) transaction.put({ ...record, index })
  })
}

function reorderElementRecords(
  records: readonly BoardElementRecord[],
  selectedIds: ReadonlySet<string>,
  placement: BoardElementReorderPlacement,
) {
  const reordered = [...records]
  if (placement === 'front' || placement === 'back') {
    const selected = reordered.filter((record) => selectedIds.has(record.id))
    const unselected = reordered.filter((record) => !selectedIds.has(record.id))
    return placement === 'front'
      ? [...unselected, ...selected]
      : [...selected, ...unselected]
  }

  if (placement === 'forward') {
    for (let index = reordered.length - 2; index >= 0; index -= 1) {
      if (
        selectedIds.has(reordered[index].id)
        && !selectedIds.has(reordered[index + 1].id)
      ) {
        const next = reordered[index + 1]
        reordered[index + 1] = reordered[index]
        reordered[index] = next
      }
    }
    return reordered
  }

  for (let index = 1; index < reordered.length; index += 1) {
    if (
      selectedIds.has(reordered[index].id)
      && !selectedIds.has(reordered[index - 1].id)
    ) {
      const previous = reordered[index - 1]
      reordered[index - 1] = reordered[index]
      reordered[index] = previous
    }
  }
  return reordered
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
