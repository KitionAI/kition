/**
 * The extension service module announces itself here from its last statement (see
 * serviceLoader.ts). This module knows nothing of the service, so it can sit between the two.
 */
let announce: ((service: () => unknown) => void) | null = null
export const announcedService = new Promise<() => unknown>((resolve) => {
  announce = resolve
})

export function announceExtensionService(service: () => unknown) {
  announce?.(service)
}
