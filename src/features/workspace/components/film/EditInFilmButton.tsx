import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClapperboardIcon as Clapperboard, LoaderCircleIcon as Loader2 } from '@kition/tessera/icons/react'
import { notify } from '@/lib/notify'
import { requestShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import { kitEditorFor } from '../kits/kitEditors'
import { createProjectFromClip } from './filmMovies'

/** "Edit in Film" on a video file: a new project beside it with the clip on a sequence, opened. */
export function EditInFilmButton({ path }: { path: string }) {
  const { t } = useTranslation('workspace')
  const [busy, setBusy] = useState(false)

  if (!kitEditorFor('film')) return null
  return (
    <button
      type="button"
      className="workspace-file-viewer__action"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          requestShowWorkspaceFile(await createProjectFromClip(path), true)
        } catch (error) {
          notify.error(t('filmKit.editFailed'), { description: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }}
      data-testid="film-edit-clip"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Clapperboard className="size-3.5" aria-hidden="true" />}
      <span>{t('filmKit.editInFilm')}</span>
    </button>
  )
}
