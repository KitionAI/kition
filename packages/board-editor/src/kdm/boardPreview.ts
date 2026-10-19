/** A board as it was at a point of its history, drawn for the version history's preview. */
import { randomActor, Replica } from '@kition/kdm'
import { exportBoardSvg } from '../lib/boardExport'
import { boardElementFromRecord } from '../lib/boardRecords'
import { boardSchema } from './boardSchema'
import { readBoardPageRecords, readBoardRecords, readBoardTitle } from './boardKdmRead'

/** The first page of the board `snapshot` holds, as SVG text; empty when the page has nothing to draw. */
export function boardPreviewSvg(snapshot: Uint8Array): string {
  const replica = Replica.load(boardSchema, snapshot, randomActor())
  const firstPage = [...readBoardPageRecords(replica)].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))[0]?.id
  const elements = readBoardRecords(replica).flatMap((record) =>
    record.record_type === 'element' && (!firstPage || record.page_id === firstPage) ? [boardElementFromRecord(record)] : [],
  )
  return exportBoardSvg({ elements, title: readBoardTitle(replica) })
}
