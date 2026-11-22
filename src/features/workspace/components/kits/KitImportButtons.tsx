import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as Loader2 } from '@kition/tessera/icons/react'
import { KitIcon } from '@/components/KitIcon'
import { notify } from '@/lib/notify'
import { requestShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import type { KitEditorEntry } from './kitEditors'
import { createProjectFromClip, kitsStartingFromClip } from './kitImports'

/**
 * "Edit in <kit>" on a file a kit starts a project from (`kit.json` `imports`, platform K25): one
 * button for each such kit of this build. It makes a new project beside the file, with the file
 * on a sequence, and opens it.
 */
export function KitImportButtons({ path }: { path: string }) {
  return (
    <>
      {kitsStartingFromClip(path).map((kit) => (
        <KitImportButton key={kit.id} kit={kit} path={path} />
      ))}
    </>
  )
}

function KitImportButton({ kit, path }: { kit: KitEditorEntry; path: string }) {
  const { t } = useTranslation('workspace')
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="workspace-file-viewer__action"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          requestShowWorkspaceFile(await createProjectFromClip(kit, path), true)
        } catch (error) {
          notify.error(t('kitEditor.editInFailed', { kit: kit.title }), { description: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }}
      data-testid={`kit-edit-clip-${kit.name}`}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <KitIcon kit={kit.icon} small className="size-3.5" />}
      <span>{t('kitEditor.editIn', { kit: kit.title })}</span>
    </button>
  )
}
