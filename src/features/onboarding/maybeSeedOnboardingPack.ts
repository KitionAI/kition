import { listWorkspaceDocuments } from '@/services/desktop'
import { seedOnboardingPack } from './seedOnboardingPack'
import { isWorkspaceSeeded, markWorkspaceSeeded } from './seedMarker'

export type FirstRunDeps = {
  listDocuments: () => Promise<{ items: unknown[] }>
  seed: () => Promise<string>
  isSeeded: (vaultPath: string) => boolean
  markSeeded: (vaultPath: string) => void
}

function defaultDeps(): FirstRunDeps {
  return {
    listDocuments: () => listWorkspaceDocuments(),
    seed: () => seedOnboardingPack(),
    isSeeded: isWorkspaceSeeded,
    markSeeded: markWorkspaceSeeded,
  }
}

/**
 * Adds onboarding files the first time an empty workspace is opened.
 * Returns the seeded welcome-doc path when seeding runs, or '' when it was
 * skipped (already added, or the workspace already had content) - the caller uses
 * the path to deterministically open the welcome doc after the reload.
 * Rethrows seeding errors so the caller can surface a non-blocking notice;
 * the marker is only written after a successful decision (seed or skip).
 */
export async function maybeSeedOnboardingPack(
  workspacePath: string,
  deps: FirstRunDeps = defaultDeps(),
): Promise<string> {
  if (!workspacePath || deps.isSeeded(workspacePath)) {
    return ''
  }

  const { items } = await deps.listDocuments()
  if (items.length > 0) {
    deps.markSeeded(workspacePath)
    return ''
  }

  const welcomePath = await deps.seed()
  deps.markSeeded(workspacePath)
  return welcomePath
}
