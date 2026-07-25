import {
  importWorkspaceFile,
  listWorkspaceDocuments,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { ONBOARDING_BASE } from './onboardingManifest'

export const EMAIL_AUTOMATION_FOLDER = 'Getting Started/Guides/Email Automation'
export const EMAIL_AUTOMATION_TABLE_PATH = `${EMAIL_AUTOMATION_FOLDER}/Inbox.kitable`

type UpgradeDeps = {
  listDocuments: () => Promise<{ items: WorkspaceDocumentTreeItem[] }>
  fetchBinary: (url: string) => Promise<Uint8Array>
  importFile: (request: { folder: string; filename: string; base64_content: string }) => Promise<unknown>
}

const defaultDeps: UpgradeDeps = {
  listDocuments: () => listWorkspaceDocuments(),
  fetchBinary: async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  },
  importFile: (request) => importWorkspaceFile(request),
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunk)))
  }
  return btoa(binary)
}

function findItem(
  items: WorkspaceDocumentTreeItem[],
  path: string,
): WorkspaceDocumentTreeItem | null {
  for (const item of items) {
    if (item.path === path) return item
    const nested = findItem(item.children || [], path)
    if (nested) return nested
  }
  return null
}

/** Adds newly introduced onboarding assets without overwriting existing files. */
export async function upgradeOnboardingPack(deps: UpgradeDeps = defaultDeps): Promise<string> {
  const { items } = await deps.listDocuments()
  const folder = findItem(items, EMAIL_AUTOMATION_FOLDER)
  if (!folder || folder.type !== 'folder') return ''
  if (findItem(folder.children || [], EMAIL_AUTOMATION_TABLE_PATH)) return ''

  const bytes = await deps.fetchBinary(`${ONBOARDING_BASE}/email-automation/Inbox.kitable`)
  await deps.importFile({
    folder: EMAIL_AUTOMATION_FOLDER,
    filename: 'Inbox.kitable',
    base64_content: uint8ToBase64(bytes),
  })
  return EMAIL_AUTOMATION_TABLE_PATH
}
