import type { WhiteboardElement } from './whiteboardTypes'

let nextElementSequence = 0
let nextPageSequence = 0

export function createWhiteboardElementId(kind: WhiteboardElement['kind']) {
  nextElementSequence += 1
  return `${kind}-${Date.now().toString(36)}-${nextElementSequence.toString(36)}`
}

export function createWhiteboardPageId() {
  nextPageSequence += 1
  return `page-${Date.now().toString(36)}-${nextPageSequence.toString(36)}`
}
