/** Export choices that persist across sessions: scale and background handling. */
export type DesignExportPresets = {
  scale: 1 | 2 | 3
  background: 'keep' | 'transparent' | 'white'
}

const DESIGN_EXPORT_PRESETS_KEY = 'kition.design.export.v1'
export const DEFAULT_EXPORT_PRESETS: DesignExportPresets = { scale: 1, background: 'keep' }

export function loadDesignExportPresets(storage: Pick<Storage, 'getItem'> | null = readStorage()): DesignExportPresets {
  try {
    const raw = storage?.getItem(DESIGN_EXPORT_PRESETS_KEY)
    if (!raw) return DEFAULT_EXPORT_PRESETS
    const parsed = JSON.parse(raw) as Partial<DesignExportPresets>
    return {
      scale: parsed.scale === 2 || parsed.scale === 3 ? parsed.scale : 1,
      background:
        parsed.background === 'transparent' || parsed.background === 'white' ? parsed.background : 'keep',
    }
  } catch {
    return DEFAULT_EXPORT_PRESETS
  }
}

export function saveDesignExportPresets(presets: DesignExportPresets, storage: Pick<Storage, 'setItem'> | null = readStorage()) {
  try {
    storage?.setItem(DESIGN_EXPORT_PRESETS_KEY, JSON.stringify(presets))
  } catch {
    /* Private mode or a full store: the choice just does not persist. */
  }
}

/** The background override an export applies, or undefined to keep the artboard's. */
export function exportBackground(presets: DesignExportPresets): string | undefined {
  if (presets.background === 'transparent') return 'transparent'
  if (presets.background === 'white') return '#ffffff'
  return undefined
}

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}
