import { KITION_KIT_HOST, createKitFile, type KitEngine } from '@/features/kits/public'
import { splitWorkspacePath, unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
import { FILM_SDK } from './filmKitSdk'

const EXPORT_STEP_MS = 150

/**
 * A video project for editing a clip: `<clip>.fcproj` beside it, with the clip
 * on a sequence of the clip's own size and frame rate. The clip itself is never
 * changed; an export makes a new movie.
 */
export async function createProjectFromClip(clipPath: string) {
  const { folder, name, stem } = splitWorkspacePath(clipPath)
  const project = await unusedWorkspacePath(folder, stem, 'fcproj')
  await createKitFile(KITION_KIT_HOST, FILM_SDK, project, { width: 1920, height: 1080 }, async (engine) => {
    // The project sits beside the clip, so the clip is named by its file name alone.
    const imported = JSON.parse(await engine.execute('file.import', { paths: [name] })) as { items?: number[]; errors?: unknown[] }
    if (!imported.items?.length) throw new Error(`${name} could not be imported`)
    await engine.execute('file.newSequenceFromClip', { items: imported.items })
  })
  return project
}

export type ExportProgress = { fraction: number; secondsLeft: number | null }

type ExportReport = { finished: boolean; progress?: number; etaSeconds?: number | null; result?: { error?: string } | null }

/**
 * Exports the active sequence as an H.264 MP4 beside the project, under an unused name:
 * the engine encodes it step by step in its worker (WebAssembly has no threads), then the
 * movie is written to the workspace as a new file. Returns its workspace path.
 */
export async function exportMovie(doc: KitEngine, projectPath: string, onProgress: (progress: ExportProgress) => void, signal: AbortSignal) {
  const { folder, stem } = splitWorkspacePath(projectPath)
  const target = await unusedWorkspacePath(folder, stem, 'mp4')
  const fileName = splitWorkspacePath(target).name
  const started = JSON.parse(await doc.execute('file.exportMedia', { path: fileName, format: 'h264' })) as { job?: number }
  if (started.job == null) throw new Error('the export did not start')
  let report: ExportReport
  do {
    if (signal.aborted) await doc.invoke('cancelJob', started.job)
    report = JSON.parse(await doc.invoke<string>('exportStep', started.job, EXPORT_STEP_MS)) as ExportReport
    onProgress({ fraction: report.progress ?? 0, secondsLeft: report.etaSeconds ?? null })
  } while (!report.finished)
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
  if (report.result?.error) throw new Error(report.result.error)
  const bytes = await doc.invoke<Uint8Array | undefined>('takeFile', fileName)
  if (!bytes) throw new Error('the export produced no file')
  await KITION_KIT_HOST.write(target, bytes)
  return target
}
