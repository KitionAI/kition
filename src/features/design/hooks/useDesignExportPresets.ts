import { useCallback, useState } from 'react'
import {
  loadDesignExportPresets,
  saveDesignExportPresets,
  type DesignExportPresets,
} from '../lib/designExportPresets'

/** Export presets kept in local storage so the next export starts from the last choice. */
export function useDesignExportPresets() {
  const [presets, setPresets] = useState<DesignExportPresets>(() => loadDesignExportPresets())
  const update = useCallback((patch: Partial<DesignExportPresets>) => {
    setPresets((current) => {
      const next = { ...current, ...patch }
      saveDesignExportPresets(next)
      return next
    })
  }, [])
  return { presets, update }
}
