export const RUNTIME_LABEL_ENV = 'KITION_DESKTOP_RUNTIME_LABEL'

const runtimeLabels = new Set(['local-runtime', 'dev-runtime'])

export function runtimeLabelForResolutionSource(source) {
  return source === 'explicit' ? 'local-runtime' : 'dev-runtime'
}

export function normalizeRuntimeLabel(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return runtimeLabels.has(normalized) ? normalized : ''
}
