import type { WhiteboardElement } from './whiteboardTypes'

let nextElementSequence = 0

export function createWhiteboardElementId(kind: WhiteboardElement['kind']) {
  nextElementSequence += 1
  return `${kind}-${Date.now().toString(36)}-${nextElementSequence.toString(36)}`
}
