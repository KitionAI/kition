/**
 * Whether Playwright can read a request body the page sends as a Blob. In WebKit it cannot
 * (the route sees zero bytes), so specs that check what was saved skip that check there; the
 * real runtime receives the bytes either way.
 */
export function canReadBlobBodies(browserName: string) {
  return browserName !== 'webkit'
}
