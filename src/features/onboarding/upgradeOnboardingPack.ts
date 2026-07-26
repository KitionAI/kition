import {
  createWorkspaceFolder,
  importWorkspaceFile,
  listWorkspaceDocuments,
  writeWorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { ONBOARDING_BASE } from './onboardingManifest'

export const ONBOARDING_GUIDES_FOLDER = 'Getting Started/Guides'
export const EMAIL_AUTOMATION_FOLDER = 'Getting Started/Guides/Email Automation'
export const EMAIL_AUTOMATION_TABLE_PATH = `${EMAIL_AUTOMATION_FOLDER}/Inbox.kitable`
export const WEB_RESEARCH_FOLDER = 'Getting Started/Guides/Web Research'
export const WEB_RESEARCH_INFO_PATH = `${WEB_RESEARCH_FOLDER}/info.md`

type UpgradeDeps = {
  listDocuments: () => Promise<{ items: WorkspaceDocumentTreeItem[] }>
  fetchBinary: (url: string) => Promise<Uint8Array>
  fetchText: (url: string) => Promise<string>
  createFolder: (request: { parent_folder: string; name: string }) => Promise<unknown>
  importFile: (request: { folder: string; filename: string; base64_content: string }) => Promise<unknown>
  writeDocument: (path: string, content: string) => Promise<unknown>
}

const defaultDeps: UpgradeDeps = {
  listDocuments: () => listWorkspaceDocuments(),
  fetchBinary: async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  },
  fetchText: async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`)
    return response.text()
  },
  createFolder: (request) => createWorkspaceFolder(request),
  importFile: (request) => importWorkspaceFile(request),
  writeDocument: (path, content) => writeWorkspaceDocument(path, content),
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
  const guidesFolder = findItem(items, ONBOARDING_GUIDES_FOLDER)
  if (!guidesFolder || guidesFolder.type !== 'folder') return ''

  let upgradedPath = ''
  const emailFolder = findItem(guidesFolder.children || [], EMAIL_AUTOMATION_FOLDER)
  if (
    emailFolder?.type === 'folder' &&
    !findItem(emailFolder.children || [], EMAIL_AUTOMATION_TABLE_PATH)
  ) {
    const bytes = await deps.fetchBinary(`${ONBOARDING_BASE}/email-automation/Inbox.kitable`)
    await deps.importFile({
      folder: EMAIL_AUTOMATION_FOLDER,
      filename: 'Inbox.kitable',
      base64_content: uint8ToBase64(bytes),
    })
    upgradedPath = EMAIL_AUTOMATION_TABLE_PATH
  }

  const webResearchFolder = findItem(guidesFolder.children || [], WEB_RESEARCH_FOLDER)
  if (webResearchFolder && webResearchFolder.type !== 'folder') {
    return upgradedPath
  }
  if (!webResearchFolder) {
    await deps.createFolder({
      parent_folder: ONBOARDING_GUIDES_FOLDER,
      name: 'Web Research',
    })
  }
  if (
    !webResearchFolder ||
    !findItem(webResearchFolder.children || [], WEB_RESEARCH_INFO_PATH)
  ) {
    const body = await deps.fetchText(`${ONBOARDING_BASE}/web-research/info.md`)
    await deps.writeDocument(WEB_RESEARCH_INFO_PATH, body)
    upgradedPath ||= WEB_RESEARCH_INFO_PATH
  }

  return upgradedPath
}
