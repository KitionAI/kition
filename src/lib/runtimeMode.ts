export function isWebPreviewMode() {
  return typeof __APP_WEB_PREVIEW__ !== 'undefined' && __APP_WEB_PREVIEW__ === true
}
