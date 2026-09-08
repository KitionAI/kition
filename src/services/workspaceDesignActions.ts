export const DESIGN_IMAGE_ACTION = 'kition:design:use-image'
export function requestUseImageInDesign(path: string, createNew = false) {
  window.dispatchEvent(
    new CustomEvent(DESIGN_IMAGE_ACTION, { detail: { path, createNew } }),
  )
}
