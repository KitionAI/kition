import { useEffect } from 'react'

import { notify } from '@/lib/notify'

type UseWorkspaceErrorNoticeOptions = {
  error: string
  /** The error is the Agent asking for a model; offer the settings shortcut. */
  agentNeedsModelConfig: boolean
  onOpenModelSettings?: () => void
}

/** One persistent toast for the workspace-level error, cleared when the error clears. */
export function useWorkspaceErrorNotice({ error, agentNeedsModelConfig, onOpenModelSettings }: UseWorkspaceErrorNoticeOptions) {
  useEffect(() => {
    const id = 'workspace-error'
    if (!error) {
      notify.dismiss(id)
      return
    }
    if (agentNeedsModelConfig && onOpenModelSettings) {
      notify.persistentError(error, { label: 'Configure', onClick: onOpenModelSettings }, { id })
    } else {
      notify.error(error, { id })
    }
  }, [error, agentNeedsModelConfig, onOpenModelSettings])
}
