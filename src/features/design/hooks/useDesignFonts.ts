import { useEffect, useState } from 'react'
import { loadDesignFonts } from '../lib/designFonts'

/** Loads the bundled faces once and re-renders when they arrive, since text metrics change. */
export function useDesignFonts() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void loadDesignFonts().then(() => setLoaded(true))
  }, [])
  return loaded
}
