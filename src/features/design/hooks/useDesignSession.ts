import { useEffect, useState } from 'react'
import {
  readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges,
} from '@/services/desktop'
import { DesignSession } from '../lib/designSession'
export function useDesignSession(root: string, path: string, reload: number) {
  const [state, setState] = useState<{
    session: DesignSession | null
    error: string
  }>({ session: null, error: '' })
  useEffect(() => {
    let disposed = false,
      disconnect: (() => void) | undefined,
      unsubscribe: (() => void) | undefined
    setState({ session: null, error: '' })
    void readWorkspaceDocument(path, root)
      .then((file) => {
        if (disposed) return
        const session = new DesignSession(root, path, file.content)
        disconnect = session.connect()
        unsubscribe = subscribeWorkspaceDocumentExternalChanges((change) => {
          if (change.path === path) void session.checkExternal()
        })
        setState({ session, error: '' })
      })
      .catch((error) => {
        if (!disposed) setState({ session: null, error: String(error) })
      })
    return () => {
      disposed = true
      unsubscribe?.()
      disconnect?.()
    }
  }, [root, path, reload])
  return state
}
