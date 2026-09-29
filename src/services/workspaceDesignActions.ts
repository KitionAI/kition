import type { BoardFrameSnapshot, DesignRecordRef } from '@/types/designStart'

export const DESIGN_IMAGE_ACTION = 'kition:design:use-image'
export const DESIGN_FROM_RECORD_ACTION = 'kition:design:from-record'
export const DESIGN_FROM_BOARD_ACTION = 'kition:design:from-board-frame'

export type DesignImageRequest = { path: string; createNew?: boolean; headline?: string }
export type DesignRecordRequest = { title: string; fields: Record<string, unknown>; record?: DesignRecordRef }
export type DesignDocumentInsertRequest = { assetPath: string; title: string }
export type DesignTableSendRequest = { file: File; ref: DesignRecordRef }

export const DESIGN_INSERT_DOCUMENT_ACTION = 'kition:design:insert-into-document'
export const DESIGN_SEND_TABLE_ACTION = 'kition:design:send-to-table'

/** Asks the workspace to link an exported design image into the last active document. */
export function requestInsertDesignIntoDocument(detail: DesignDocumentInsertRequest) {
  window.dispatchEvent(new CustomEvent<DesignDocumentInsertRequest>(DESIGN_INSERT_DOCUMENT_ACTION, { detail }))
}

/** Asks the workspace to attach an exported design image to its source record. */
export function requestSendDesignToTable(detail: DesignTableSendRequest) {
  window.dispatchEvent(new CustomEvent<DesignTableSendRequest>(DESIGN_SEND_TABLE_ACTION, { detail }))
}

/** Places an image in the active design, or starts a new design from it; a headline stays editable text. */
export function requestUseImageInDesign(path: string, createNew = false, headline?: string) {
  window.dispatchEvent(
    new CustomEvent<DesignImageRequest>(DESIGN_IMAGE_ACTION, { detail: { path, createNew, headline } }),
  )
}

export function requestDesignFromRecord(detail: DesignRecordRequest) {
  window.dispatchEvent(new CustomEvent<DesignRecordRequest>(DESIGN_FROM_RECORD_ACTION, { detail }))
}

export function requestDesignFromBoardFrame(detail: BoardFrameSnapshot) {
  window.dispatchEvent(new CustomEvent<BoardFrameSnapshot>(DESIGN_FROM_BOARD_ACTION, { detail }))
}
