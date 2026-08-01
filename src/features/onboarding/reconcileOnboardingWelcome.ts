import {
  listWorkspaceDocuments,
  moveWorkspaceDocument,
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { ONBOARDING_WELCOME_PATH } from './onboardingManifest'

const LEGACY_WELCOME_PATH = 'Welcome to Kition.md'
const LEGACY_LOGO_MARKDOWN = '![Kition](Getting Started/logo.png)'
const CURRENT_LOGO_MARKDOWN = '![Kition](logo.png)'

export type ReconcileOnboardingWelcomeDeps = {
  listDocuments: typeof listWorkspaceDocuments
  moveDocument: typeof moveWorkspaceDocument
  readDocument: typeof readWorkspaceDocument
  writeDocument: typeof writeWorkspaceDocument
}

const defaultDeps: ReconcileOnboardingWelcomeDeps = {
  listDocuments: listWorkspaceDocuments,
  moveDocument: moveWorkspaceDocument,
  readDocument: readWorkspaceDocument,
  writeDocument: writeWorkspaceDocument,
}

function collectPaths(items: WorkspaceDocumentTreeItem[], paths = new Set<string>()) {
  for (const item of items) {
    paths.add(item.path)
    if (item.children?.length) collectPaths(item.children, paths)
  }
  return paths
}

async function reconcileLogoReference(
  path: string,
  deps: ReconcileOnboardingWelcomeDeps,
) {
  const document = await deps.readDocument(path)
  const content = document.content.replace(LEGACY_LOGO_MARKDOWN, CURRENT_LOGO_MARKDOWN)
  if (content === document.content) return false
  await deps.writeDocument(path, content)
  return true
}

/**
 * Moves the v0.1.5 root-level welcome guide into Getting Started and updates
 * its logo to a same-folder Markdown reference. Returns the mutated path so
 * the workspace tree can reload without reopening first-run onboarding.
 */
export async function reconcileOnboardingWelcome(
  deps: ReconcileOnboardingWelcomeDeps = defaultDeps,
): Promise<string> {
  const workspace = await deps.listDocuments()
  const paths = collectPaths(workspace.items)

  if (paths.has(ONBOARDING_WELCOME_PATH)) {
    const changed = await reconcileLogoReference(ONBOARDING_WELCOME_PATH, deps)
    return changed ? ONBOARDING_WELCOME_PATH : ''
  }
  if (!paths.has(LEGACY_WELCOME_PATH)) return ''

  const legacyDocument = await deps.readDocument(LEGACY_WELCOME_PATH)
  if (!legacyDocument.content.includes('# Welcome to Kition')) return ''

  const moved = await deps.moveDocument({
    path: LEGACY_WELCOME_PATH,
    target_folder: 'Getting Started',
  })
  await reconcileLogoReference(moved.path, deps)
  return moved.path
}
