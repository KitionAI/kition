/** Record diffs (computing, reversing, squashing them) and record equality. */
import { cloneBoardRecord, compareBoardRecords, type BoardRecord } from './boardRecords'
import { boardRecordsEqual } from './boardRecordEquality'

export { boardRecordsEqual, boardValuesEqual } from './boardRecordEquality'

type BoardRecordUpdate = {
  before: BoardRecord
  after: BoardRecord
}

export type BoardRecordDiff = {
  added: BoardRecord[]
  updated: BoardRecordUpdate[]
  removed: BoardRecord[]
}

export function reverseBoardRecordDiff(diff: BoardRecordDiff): BoardRecordDiff {
  return {
    added: diff.removed.map(cloneBoardRecord),
    updated: diff.updated.map((update) => ({
      before: cloneBoardRecord(update.after),
      after: cloneBoardRecord(update.before),
    })),
    removed: diff.added.map(cloneBoardRecord),
  }
}

export function squashBoardRecordDiffs(
  diffs: readonly BoardRecordDiff[],
): BoardRecordDiff {
  const transitions = new Map<string, {
    before: BoardRecord | undefined
    after: BoardRecord | undefined
  }>()

  for (const diff of diffs) {
    for (const record of diff.added) {
      const transition = transitions.get(record.id)
      transitions.set(record.id, {
        before: transition?.before,
        after: cloneBoardRecord(record),
      })
    }
    for (const update of diff.updated) {
      const transition = transitions.get(update.after.id)
      transitions.set(update.after.id, {
        before: transition ? transition.before : cloneBoardRecord(update.before),
        after: cloneBoardRecord(update.after),
      })
    }
    for (const record of diff.removed) {
      const transition = transitions.get(record.id)
      transitions.set(record.id, {
        before: transition ? transition.before : cloneBoardRecord(record),
        after: undefined,
      })
    }
  }

  const squashed: BoardRecordDiff = {
    added: [],
    updated: [],
    removed: [],
  }
  for (const transition of transitions.values()) {
    if (transition.before === undefined && transition.after) {
      squashed.added.push(cloneBoardRecord(transition.after))
    } else if (transition.before && transition.after === undefined) {
      squashed.removed.push(cloneBoardRecord(transition.before))
    } else if (
      transition.before
      && transition.after
      && !boardRecordsEqual(transition.before, transition.after)
    ) {
      squashed.updated.push({
        before: cloneBoardRecord(transition.before),
        after: cloneBoardRecord(transition.after),
      })
    }
  }
  squashed.added.sort(compareBoardRecords)
  squashed.removed.sort(compareBoardRecords)
  squashed.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
  return squashed
}

export function isBoardRecordDiffEmpty(diff: BoardRecordDiff) {
  return diff.added.length === 0
    && diff.updated.length === 0
    && diff.removed.length === 0
}

/** The record diff that turns the view `before` into the view `after`. */
export function diffBoardRecords(
  before: ReadonlyMap<string, BoardRecord>,
  after: ReadonlyMap<string, BoardRecord>,
): BoardRecordDiff {
  const diff: BoardRecordDiff = { added: [], updated: [], removed: [] }
  for (const [id, record] of after) {
    const previous = before.get(id)
    if (!previous) diff.added.push(cloneBoardRecord(record))
    else if (previous !== record && !boardRecordsEqual(previous, record)) {
      diff.updated.push({ before: cloneBoardRecord(previous), after: cloneBoardRecord(record) })
    }
  }
  for (const [id, record] of before) {
    if (!after.has(id)) diff.removed.push(cloneBoardRecord(record))
  }
  diff.added.sort(compareBoardRecords)
  diff.removed.sort(compareBoardRecords)
  diff.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
  return diff
}
