import { KITION_KIT_HOST, createKitFile } from '@/features/kits/public'
import { kitCatalog } from '@/lib/kitCatalog'
import { splitWorkspacePath, unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
import type { KitEditorEntry } from './kitEditors'

/**
 * `project-from-clip` (`kit.json` `imports[].action`, platform K25): the kit starts a project
 * from a media file. A kit that declares it has the two commands the action names: the first
 * takes the file into the project (`{ paths }`, answers `{ items }`), the second makes a sequence
 * of the clip's own size and frame rate from those items (`{ items }`).
 */
const PROJECT_FROM_CLIP = { action: 'project-from-clip', import: 'file.import', sequence: 'file.newSequenceFromClip' } as const

/** The kits of this build that start a project from the file at `path`, each with what it creates. */
export function kitsStartingFromClip(path: string): KitEditorEntry[] {
  const extension = splitWorkspacePath(path).name.split('.').pop()?.toLowerCase() ?? ''
  return kitCatalog()
    .filter((kit) => kit.creates.length > 0 && kit.imports.some((each) => each.action === PROJECT_FROM_CLIP.action && each.extensions.includes(extension)))
    .map((kit) => ({ ...kit, key: kit.name, icon: kit.name }))
}

/**
 * A project of `kit` for editing a clip: a new document beside the clip, named after it, with the
 * clip on a sequence of the clip's own size and frame rate. The clip itself is never changed.
 */
export async function createProjectFromClip(kit: KitEditorEntry, clipPath: string) {
  const { folder, name, stem } = splitWorkspacePath(clipPath)
  const create = kit.creates[0]
  if (!create) throw new Error(`${kit.title} creates no document`)
  const project = await unusedWorkspacePath(folder, stem, create.extension)
  await createKitFile(KITION_KIT_HOST, kit.engine, project, create.size, async (engine) => {
    // The project sits beside the clip, so the clip is named by its file name alone.
    const imported = JSON.parse(await engine.execute(PROJECT_FROM_CLIP.import, { paths: [name] })) as { items?: number[]; errors?: unknown[] }
    if (!imported.items?.length) throw new Error(`${name} could not be imported`)
    await engine.execute(PROJECT_FROM_CLIP.sequence, { items: imported.items })
  })
  return project
}
