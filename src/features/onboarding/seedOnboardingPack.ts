import {
  createWorkspaceFolder,
  importWorkspaceFile,
  writeWorkspaceDocument,
} from '@/services/desktop'
import type { OnboardingGuide, OnboardingGuideManifest } from './onboardingGuideManifest'
import {
  ONBOARDING_BASE,
  fetchOnboardingManifest,
} from './onboardingManifest'

export type SeedDeps = {
  fetchText: (url: string) => Promise<string>
  fetchBinary: (url: string) => Promise<Uint8Array>
  createFolder: (req: { parent_folder: string; name: string }) => Promise<unknown>
  writeDocument: (path: string, content: string) => Promise<unknown>
  importFile: (req: { folder: string; filename: string; base64_content: string }) => Promise<unknown>
}

const defaultDeps: SeedDeps = {
  fetchText: async (url) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`)
    return res.text()
  },
  fetchBinary: async (url) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  },
  createFolder: (req) => createWorkspaceFolder(req),
  writeDocument: (path, content) => writeWorkspaceDocument(path, content),
  importFile: (req) => importWorkspaceFile(req),
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

async function importBinaryAssets(
  files: Array<{ url: string; folder: string; filename: string }>,
  deps: SeedDeps,
): Promise<void> {
  const queue = [...files]
  const concurrency = 3

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file) return
      const bytes = await deps.fetchBinary(file.url)
      await deps.importFile({
        folder: file.folder,
        filename: file.filename,
        base64_content: uint8ToBase64(bytes),
      })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

async function seedOnboardingGuide(
  guideBase: string,
  guideRoot: string,
  guide: OnboardingGuide,
  deps: SeedDeps,
): Promise<void> {
  const guideFolder = `${guideRoot}/${guide.displayName}`
  const seedsFolder = `${guideFolder}/seeds`
  const assetsFolder = `${guideFolder}/assets`

  await deps.createFolder({ parent_folder: guideRoot, name: guide.displayName })
  if (guide.seeds.length > 0) {
    await deps.createFolder({ parent_folder: guideFolder, name: 'seeds' })
  }
  if ((guide.assets?.length ?? 0) > 0) {
    await deps.createFolder({ parent_folder: guideFolder, name: 'assets' })
  }

  const intro = await deps.fetchText(`${guideBase}/${guide.slug}/${guide.intro}`)
  await deps.writeDocument(`${guideFolder}/${guide.intro}`, intro)

  const files: Array<{ url: string; folder: string; filename: string }> = []
  if (guide.tableFile) {
    files.push({
      url: `${guideBase}/${guide.slug}/${guide.tableFile}`,
      folder: guideFolder,
      filename: guide.tableFile,
    })
  }
  for (const filename of guide.seeds) {
    files.push({
      url: `${guideBase}/${guide.slug}/seeds/${filename}`,
      folder: seedsFolder,
      filename,
    })
  }
  for (const filename of guide.assets ?? []) {
    files.push({
      url: `${guideBase}/${guide.slug}/assets/${filename}`,
      folder: assetsFolder,
      filename,
    })
  }
  await importBinaryAssets(files, deps)
}

/** Adds the onboarding files to the active workspace. Returns the welcome document path. */
export async function seedOnboardingPack(deps: SeedDeps = defaultDeps): Promise<string> {
  const manifest = await fetchOnboardingManifest(deps.fetchText)
  const folder = manifest.folder

  await deps.createFolder({ parent_folder: '', name: folder })

  const welcomeBody = await deps.fetchText(`${ONBOARDING_BASE}/${manifest.welcome.asset}`)
  const welcomePath = `${folder}/${manifest.welcome.filename}`
  await deps.writeDocument(welcomePath, welcomeBody)

  for (const image of manifest.images ?? []) {
    const bytes = await deps.fetchBinary(`${ONBOARDING_BASE}/${image.asset}`)
    await deps.importFile({
      folder,
      filename: image.filename,
      base64_content: uint8ToBase64(bytes),
    })
  }

  const productFolders = new Set<string>()
  for (const item of [...manifest.tables, ...(manifest.documents ?? [])]) {
    if (item.folder?.trim()) productFolders.add(item.folder.trim())
  }
  if (manifest.guides?.folder?.trim()) productFolders.add(manifest.guides.folder.trim())
  for (const productFolder of productFolders) {
    await deps.createFolder({ parent_folder: folder, name: productFolder })
  }

  for (const document of manifest.documents ?? []) {
    const body = await deps.fetchText(`${ONBOARDING_BASE}/${document.asset}`)
    const documentFolder = document.folder ? `${folder}/${document.folder}` : folder
    await deps.writeDocument(`${documentFolder}/${document.filename}`, body)
  }

  for (const table of manifest.tables) {
    const bytes = await deps.fetchBinary(`${ONBOARDING_BASE}/${table.asset}`)
    await deps.importFile({
      folder: table.folder ? `${folder}/${table.folder}` : folder,
      filename: table.filename,
      base64_content: uint8ToBase64(bytes),
    })
  }

  if (manifest.guides) {
    const manifestURL = `${ONBOARDING_BASE}/${manifest.guides.manifest}`
    const guideManifest = JSON.parse(await deps.fetchText(manifestURL)) as OnboardingGuideManifest
    const guideRoot = manifest.guides.folder
      ? `${folder}/${manifest.guides.folder}`
      : folder
    for (const guide of guideManifest.guides) {
      await seedOnboardingGuide(ONBOARDING_BASE, guideRoot, guide, deps)
    }
  }

  return welcomePath
}
