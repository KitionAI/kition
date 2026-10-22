/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/transport.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

/**
 * The request header that carries this launch's API token.
 */
export type TransportTokenHeader = "Kition-Token"

/**
 * A signed URL path, for GET and HEAD only: /_signed/<expires>.<length>.<signature>/<path>. <signature> is the lower-case hex HMAC-SHA-256, keyed with the token (UTF-8), of `<expires>\n<scope>`, where <scope> is the first <length> bytes of /<path> as sent (percent-encoded). A file URL signs its whole path; a kit engine's lent root signs the folder /kit-files/ and the engine appends the rest. Valid until <expires> (Unix seconds), and only when <scope> starts with /workspace-files/, /kit-files/, /uploads/, <api prefix>/kits/bridge, or <api prefix>/data-documents/. The request is routed as /<path>; the token itself is never in a URL.
 */
export type TransportSignedPath = string

/**
 * A route that needs no token: the health probe, and the portal sign-in callback the system browser reaches (protected by its state).
 */
export type TransportOpenRoute = {
  method: "GET"
  path: "/health" | "/api/v1/desktop/portal/callback"
}

/**
 * data.reason of a request the token gate refused.
 */
export type TransportRefusalReason = "api_token"

/**
 * The 401 answer to a request without the token, with a wrong one, or with a bad or expired signed URL.
 */
export type TransportRefusal = {
  code: 401
  message: string
  data: {
    reason: TransportRefusalReason
  }
}

/**
 * How a caller reaches the runtime at all (kit frame isolation, phase 1). The runtime binds to 127.0.0.1 only and refuses a Host that is not loopback. Every request carries this launch's API token in the Kition-Token header (tokenHeader), or is a signed URL made with it (signedPath); everything else is answered 401 (refusal) before routing, unknown paths included, so a refused request has no side effect. The open list (openRoute) needs no token. Cross-origin requests are allowed only from the desktop renderer (tauri://localhost, http(s)://tauri.localhost) and, in development, the exact dev-server origin; other origins, other localhost pages among them, get 403 and no CORS headers. The desktop shell makes the token per launch (256 random bits, hex), hands it to its main frame's bootstrap script only, which the renderer takes off window as it loads; the runtime writes it to api-token beside its database (data/api-token in Kition's data directory), mode 0600, never inside a folder it serves, for trusted local clients such as kition-acp. File answers carry X-Content-Type-Options: nosniff, and HTML, XHTML, SVG, and XML answers Content-Security-Policy: sandbox.
 */
export type TransportContract = TransportRefusal
