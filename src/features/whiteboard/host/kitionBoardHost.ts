import type { BoardHost } from '@kition/board-editor'
import { importWorkspaceImageFromFile } from '@/services/desktop'
import { requestDesignFromBoardFrame } from '@/services/workspaceDesignActions'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

/** What the board editor asks of Kition: workspace files for images, and designs from frames. */
export const kitionBoardHost: BoardHost = {
  resolveFileURL: resolveWorkspaceFileURL,
  importImage: async (file, index) => {
    const imported = await importWorkspaceImageFromFile({ file, folder: 'attachments', index })
    return { path: imported.importedPath }
  },
  designFromFrame: requestDesignFromBoardFrame,
}
