import { beforeEach, describe, expect, it, vi } from 'vitest'
import { kitCatalog } from '@/lib/kitCatalog'

type Engine = { execute: (command: string, params: unknown) => Promise<string> }
const made: { path: string; size: unknown; calls: [string, unknown][] }[] = []
let answer = (command: string): string => (command === 'file.import' ? JSON.stringify({ items: [7] }) : '{}')

vi.mock('@/features/kits/public', () => ({
  KITION_KIT_HOST: {},
  createKitFile: vi.fn(async (_host: unknown, _engine: unknown, path: string, size: unknown, fill: (engine: Engine) => Promise<void>) => {
    const calls: [string, unknown][] = []
    made.push({ path, size, calls })
    await fill({ execute: async (command, params) => (calls.push([command, params]), answer(command)) })
  }),
}))
vi.mock('@/features/workspace/lib/unusedWorkspacePath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/workspace/lib/unusedWorkspacePath')>()),
  unusedWorkspacePath: vi.fn(async (folder: string, stem: string, extension: string) => `${folder ? `${folder}/` : ''}${stem}.${extension}`),
}))

import { createProjectFromClip, kitsStartingFromClip } from './kitImports'

// A kit of this build whose manifest says it starts a project from a clip, and one of the
// extensions it names (the manifests the test setup installs): the test names no kit.
const starter = kitCatalog().find((kit) => kit.creates.length && kit.imports.some((each) => each.action === 'project-from-clip'))
const extension = starter?.imports.find((each) => each.action === 'project-from-clip')?.extensions[0]

describe('a project from a clip', () => {
  beforeEach(() => {
    made.length = 0
    answer = (command) => (command === 'file.import' ? JSON.stringify({ items: [7] }) : '{}')
  })

  it('has a shipped kit whose manifest declares the import', () => {
    expect(starter && extension).toBeTruthy()
  })

  it('offers the kits whose manifest imports the file’s extension, and none for another file', () => {
    expect(kitsStartingFromClip(`media/Clip.${extension?.toUpperCase()}`).map((kit) => kit.id)).toContain(starter?.id)
    expect(kitsStartingFromClip('media/Clip.zip')).toEqual([])
    expect(kitsStartingFromClip('media/Clip')).toEqual([])
  })

  it('makes the kit’s new document beside the clip and puts the clip on a sequence', async () => {
    const [kit] = kitsStartingFromClip(`media/Clip.${extension}`)
    const project = await createProjectFromClip(kit, `media/Clip.${extension}`)
    expect(project).toBe(`media/Clip.${kit.creates[0].extension}`)
    expect(made).toEqual([
      {
        path: project,
        size: kit.creates[0].size,
        // The clip is named by its file name alone: the project sits beside it.
        calls: [
          ['file.import', { paths: [`Clip.${extension}`] }],
          ['file.newSequenceFromClip', { items: [7] }],
        ],
      },
    ])
  })

  it('fails, and makes no sequence, when the kit could not take the clip', async () => {
    answer = () => JSON.stringify({ items: [], errors: ['unreadable'] })
    const [kit] = kitsStartingFromClip(`Clip.${extension}`)
    await expect(createProjectFromClip(kit, `Clip.${extension}`)).rejects.toThrow(`Clip.${extension} could not be imported`)
    expect(made[0].calls.map(([command]) => command)).toEqual(['file.import'])
  })
})
