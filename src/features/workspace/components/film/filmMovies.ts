import { KITION_KIT_HOST, createKitFile } from '@/features/kits/public'
import { splitWorkspacePath, unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
import { kitEditorFor } from '../kits/kitEditors'

/**
 * A video project for editing a clip: `<clip>.kfilm` beside it, with the clip
 * on a sequence of the clip's own size and frame rate. The clip itself is never
 * changed; an export makes a new movie.
 */
export async function createProjectFromClip(clipPath: string) {
  const { folder, name, stem } = splitWorkspacePath(clipPath)
  const film = kitEditorFor('film')
  if (!film) throw new Error('this build has no Film kit')
  const project = await unusedWorkspacePath(folder, stem, 'kfilm')
  await createKitFile(KITION_KIT_HOST, film.engine, project, { width: 1920, height: 1080 }, async (engine) => {
    // The project sits beside the clip, so the clip is named by its file name alone.
    const imported = JSON.parse(await engine.execute('file.import', { paths: [name] })) as { items?: number[]; errors?: unknown[] }
    if (!imported.items?.length) throw new Error(`${name} could not be imported`)
    await engine.execute('file.newSequenceFromClip', { items: imported.items })
  })
  return project
}
