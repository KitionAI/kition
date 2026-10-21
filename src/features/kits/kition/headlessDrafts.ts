import { useSyncExternalStore } from 'react'
import { discardKitDraft, kitDraftRefusal, listKitDrafts, mergeKitDraft, type KitsHeadlessDraft } from '@/api/kits'
import { mountedKitDocument } from './kitConnections'
import { KITION_KIT_HOST } from './kitionHost'

/**
 * The drafts an agent keeps beside workspace files over `kition-kits-mcp --drafts` (Kit Standard
 * A27), by workspace path, as the runtime lists them. Unlike a draft in an open kit editor
 * (`kitDrafts.ts`), these live on disk, made by an agent outside Kition; the person reviews,
 * merges, or discards them here (A14). Kition watches the list while the workspace is shown.
 */
let drafts = new Map<string, KitsHeadlessDraft>()
let reviewing: string | null = null
const listeners = new Set<() => void>()
/** How often the list is read again while it is watched. */
const POLL_MS = 5_000

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function sameDrafts(next: Map<string, KitsHeadlessDraft>) {
  if (next.size !== drafts.size) return false
  for (const [path, draft] of next) {
    const known = drafts.get(path)
    if (!known || known.updated !== draft.updated || known.state !== draft.state || known.stale !== draft.stale) return false
  }
  return true
}

/** Reads the workspace's drafts again; a runtime without them (or not ready yet) lists none. */
export async function refreshHeadlessDrafts() {
  const listed = await listKitDrafts().catch(() => [] as KitsHeadlessDraft[])
  const next = new Map(listed.map((draft) => [draft.path, draft]))
  if (reviewing && !next.has(reviewing)) reviewing = null
  if (sameDrafts(next)) return
  drafts = next
  emit()
}

let watchers = 0
let stopWatching: (() => void) | null = null

/** Watches the list while something shows it (the workspace sidebar); answers the stop. */
export function watchHeadlessDrafts() {
  watchers += 1
  if (watchers === 1) {
    void refreshHeadlessDrafts()
    const timer = window.setInterval(() => void refreshHeadlessDrafts(), POLL_MS)
    const onFocus = () => void refreshHeadlessDrafts()
    window.addEventListener('focus', onFocus)
    stopWatching = () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }
  return () => {
    watchers -= 1
    if (watchers === 0) {
      stopWatching?.()
      stopWatching = null
    }
  }
}

/** The headless draft of `path`, following the list. */
export function useHeadlessDraft(path: string | null): KitsHeadlessDraft | null {
  return useSyncExternalStore(
    subscribe,
    () => (path ? (drafts.get(path) ?? null) : null),
    () => null,
  )
}

/** The path whose draft the person is reviewing, if any. */
export function useHeadlessDraftReview(): string | null {
  return useSyncExternalStore(subscribe, () => reviewing, () => null)
}

export function openHeadlessDraftReview(path: string) {
  reviewing = path
  emit()
}

export function closeHeadlessDraftReview() {
  if (reviewing === null) return
  reviewing = null
  emit()
}

/**
 * What a merge did: `merged`; `stale` when the file changed since the draft forked (merging would
 * drop those edits; the person may merge with `overwrite`); `dirty` when the file is open in a kit
 * editor with unsaved edits, which a merge never replaces (standard H6).
 */
export type HeadlessDraftMerge = 'merged' | 'stale' | 'dirty'

/** Merges the draft of `path` as the person's decision; an open, clean kit editor reloads the file. */
export async function mergeHeadlessDraft(path: string, overwrite = false): Promise<HeadlessDraftMerge> {
  const open = mountedKitDocument(path)
  if (open && (await open.connection.state()).dirty) return 'dirty'
  try {
    await mergeKitDraft(path, overwrite)
  } catch (error) {
    if (kitDraftRefusal(error) === 'stale') return 'stale'
    throw error
  }
  if (open) {
    const stamp = await KITION_KIT_HOST.stamp(path)
    if (stamp) open.connection.fileChanged(stamp)
  }
  await refreshHeadlessDrafts()
  return 'merged'
}

/** Discards the draft of `path`; the file stays as it is. */
export async function discardHeadlessDraft(path: string) {
  await discardKitDraft(path)
  await refreshHeadlessDrafts()
}

/** Forgets every draft (tests). */
export function resetHeadlessDraftsForTest() {
  drafts = new Map()
  reviewing = null
  emit()
}
