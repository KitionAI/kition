import { useCallback, useState } from 'react'
import {
  createWorkspaceFolder,
  importWorkspaceFile,
  writeWorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import {
  ONBOARDING_GUIDE_BASE,
  ONBOARDING_GUIDE_FOLDER,
  type OnboardingGuide,
  type OnboardingGuideManifest,
} from '@/features/onboarding/onboardingGuideManifest'
import { readBundledAssetBytes, readBundledAssetText } from '@/lib/bundledAssets'

export type { OnboardingGuide, OnboardingGuideManifest } from '@/features/onboarding/onboardingGuideManifest'

export type OnboardingGuideImportStatus =
  | { kind: 'idle' }
  | { kind: 'running'; current: string; finished: number; total: number }
  | { kind: 'partial'; finishedSlugs: string[]; failedSlugs: string[] }
  | { kind: 'success'; finishedSlugs: string[] }
  | { kind: 'error'; message: string }

export type ImportDeps = {
  fetchText: (url: string) => Promise<string>
  fetchBinary: (url: string) => Promise<Uint8Array>
}

const defaultDeps: ImportDeps = {
  fetchText: readBundledAssetText,
  fetchBinary: readBundledAssetBytes,
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

export function onboardingGuideFolderExists(items: WorkspaceDocumentTreeItem[], displayName: string): boolean {
  for (const item of items) {
    if (item.type === 'folder' && item.name === 'Getting Started') {
      const guidesFolder = item.children?.find(
        (child) => child.type === 'folder' && child.name === ONBOARDING_GUIDE_FOLDER,
      )
      if (guidesFolder?.children?.some(
        (child) => child.type === 'folder' && child.name === displayName,
      )) {
        return true
      }
    }
    if (item.children && onboardingGuideFolderExists(item.children, displayName)) return true
  }
  return false
}

export async function importOnboardingGuide(
  manifestBase: string,
  guide: OnboardingGuide,
  deps: ImportDeps = defaultDeps,
): Promise<void> {
  const root = 'Getting Started'
  const guideRoot = `${root}/${ONBOARDING_GUIDE_FOLDER}`
  const guideFolder = `${guideRoot}/${guide.displayName}`
  const seedsFolder = `${guideFolder}/seeds`
  const assetsFolder = `${guideFolder}/assets`

  await createWorkspaceFolder({ parent_folder: '', name: root })
  await createWorkspaceFolder({ parent_folder: root, name: ONBOARDING_GUIDE_FOLDER })
  await createWorkspaceFolder({ parent_folder: guideRoot, name: guide.displayName })
  if (guide.seeds.length > 0) {
    await createWorkspaceFolder({ parent_folder: guideFolder, name: 'seeds' })
  }
  if ((guide.assets?.length ?? 0) > 0) {
    await createWorkspaceFolder({ parent_folder: guideFolder, name: 'assets' })
  }

  const introURL = `${manifestBase}/${guide.slug}/intro.md`
  const introText = await deps.fetchText(introURL)
  await writeWorkspaceDocument(`${guideFolder}/intro.md`, introText)

  // The table file sits at the guide root beside intro.md. Import it before the
  // worker pool so the table remains available if an optional seed fails.
  if (guide.tableFile) {
    const bytes = await deps.fetchBinary(
      `${manifestBase}/${guide.slug}/${guide.tableFile}`,
    )
    await importWorkspaceFile({
      folder: guideFolder,
      filename: guide.tableFile,
      base64_content: uint8ToBase64(bytes),
    })
  }

  const queue = [
    ...guide.seeds.map((filename) => ({ filename, folder: seedsFolder, path: 'seeds' })),
    ...(guide.assets ?? []).map((filename) => ({ filename, folder: assetsFolder, path: 'assets' })),
  ]
  const concurrency = 3
  let firstError: Error | null = null

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file) return
      try {
        const bytes = await deps.fetchBinary(
          `${manifestBase}/${guide.slug}/${file.path}/${file.filename}`,
        )
        await importWorkspaceFile({
          folder: file.folder,
          filename: file.filename,
          base64_content: uint8ToBase64(bytes),
        })
      } catch (err) {
        if (!firstError) firstError = err as Error
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  if (firstError) throw firstError
}

export function useImportOnboardingGuides(
  manifest: OnboardingGuideManifest | null,
  workspaceItems: WorkspaceDocumentTreeItem[],
  refreshWorkspace: () => Promise<void>,
  deps: ImportDeps = defaultDeps,
) {
  const [status, setStatus] = useState<OnboardingGuideImportStatus>({ kind: 'idle' })

  const importSingle = useCallback(
    async (slug: string) => {
      if (!manifest) return
      const guide = manifest.guides.find((item) => item.slug === slug)
      if (!guide) return
      if (onboardingGuideFolderExists(workspaceItems, guide.displayName)) {
        setStatus({ kind: 'success', finishedSlugs: [] })
        return
      }
      setStatus({ kind: 'running', current: guide.displayName, finished: 0, total: 1 })
      try {
        await importOnboardingGuide(ONBOARDING_GUIDE_BASE, guide, deps)
        await refreshWorkspace()
        setStatus({ kind: 'success', finishedSlugs: [slug] })
      } catch (err) {
        setStatus({ kind: 'error', message: (err as Error).message || 'import failed' })
      }
    },
    [manifest, workspaceItems, refreshWorkspace, deps],
  )

  const importAll = useCallback(async () => {
    if (!manifest) return
    const ok: string[] = []
    const failed: string[] = []
    let finished = 0
    const total = manifest.guides.length
    for (const guide of manifest.guides) {
      setStatus({ kind: 'running', current: guide.displayName, finished, total })
      try {
        if (onboardingGuideFolderExists(workspaceItems, guide.displayName)) {
          ok.push(guide.slug)
        } else {
          await importOnboardingGuide(ONBOARDING_GUIDE_BASE, guide, deps)
          ok.push(guide.slug)
        }
      } catch {
        failed.push(guide.slug)
      }
      finished += 1
    }
    await refreshWorkspace()
    setStatus(
      failed.length === 0
        ? { kind: 'success', finishedSlugs: ok }
        : { kind: 'partial', finishedSlugs: ok, failedSlugs: failed },
    )
  }, [manifest, workspaceItems, refreshWorkspace, deps])

  const reset = useCallback(() => setStatus({ kind: 'idle' }), [])

  return { status, importSingle, importAll, reset }
}
