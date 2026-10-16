/**
 * The documents this person co-edits: one record per shared document (its KDM `docId`), written
 * when they share it or open a shared link, so a document that opens later knows it has a room.
 * A document without a record is never relayed.
 */
import type { Role } from '@/lib/sync'

export type CollabRoom = {
  docId: string
  shareLink: string
  /** The document's name as shared (the room's `name`). */
  name: string
  kit: string
  role: Role
  /** The replica version the room is known to hold from this side (lowercase hex), so a later
   * session sends only what is new. */
  lastSent?: string
  /** The workspace file the shared document was opened into here, if it came from a link. */
  path?: string
}

const ROOMS_KEY = 'kition.collab.rooms.v1'
const ROOMS_CHANGED_EVENT = 'kition:collab:rooms-changed'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readRooms(): Record<string, CollabRoom> {
  try {
    const parsed = JSON.parse(storage()?.getItem(ROOMS_KEY) || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CollabRoom>) : {}
  } catch {
    return {}
  }
}

export function readRoom(docId: string): CollabRoom | null {
  const room = readRooms()[docId]
  return room && room.docId === docId && typeof room.shareLink === 'string' ? room : null
}

/** Records (or replaces) a shared document; `quiet` skips telling listeners (a bookkeeping update). */
export function writeRoom(room: CollabRoom, { quiet = false } = {}) {
  const store = storage()
  if (!store) return
  store.setItem(ROOMS_KEY, JSON.stringify({ ...readRooms(), [room.docId]: room }))
  if (!quiet) window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, { detail: { docId: room.docId } }))
}

/** Hears a document becoming shared (or its record changing); answers an unsubscribe. */
export function onRoomsChanged(listener: (docId: string) => void) {
  const handler = (event: Event) => listener(String((event as CustomEvent<{ docId?: string }>).detail?.docId ?? ''))
  window.addEventListener(ROOMS_CHANGED_EVENT, handler)
  return () => window.removeEventListener(ROOMS_CHANGED_EVENT, handler)
}

export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string | undefined) {
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return new Uint8Array()
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}
