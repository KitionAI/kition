// Copied from kition-sdk packages/sync/src/openToken.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Open tokens (`ko1.`), managed co-editing card D2 (Kition platform docs/platform/managed-collab.md,
 * section 1): a host signs one person's permissions on one file version; Kition Server and the
 * kit host verify them offline against the host's public keys. The Rust twin is the
 * `kition-open-token` crate; both are held to `crates/kition-open-token/tests/vectors.json`.
 *
 * `ko1.` base64url(claims JSON) `.` base64url(Ed25519 signature over the middle segment's ASCII).
 * Uses WebCrypto (`crypto.subtle`, Ed25519 and SHA-256): browsers and Node 20+.
 */
import type { Role } from './protocol'

export const OPEN_TOKEN_PREFIX = 'ko1.'
export const OPEN_TOKEN_TYPE = 'kition-open'
export const OPEN_TOKEN_MAX_TTL = 3600
export const OPEN_TOKEN_CLOCK_SKEW = 60

/** What the person may do with the file (OT1, OT5): `edit` implies `comment`. */
export type OpenPerms = { edit: boolean; comment: boolean; download: boolean; share: boolean; export: boolean }

export type OpenTokenClaims = {
  v: 1
  typ: typeof OPEN_TOKEN_TYPE
  kid: string
  /** The host that signed it (`[A-Za-z0-9._-]`); its keys name it (I2). */
  iss: string
  /** The Kition Server it is for (I2). */
  aud: string
  tenant: string
  /** The person: the host's user id. */
  sub: string
  name: string
  /** The host's immutable resource id of the file. */
  file: string
  /** The host content revision the session opens. */
  version: string
  /** The co-editing generation: one room per `(tenant, file, doc_key)`. */
  doc_key: string
  perms: OpenPerms
  watermark: { text: string } | null
  iat: number
  exp: number
  jti?: string
}

/** A host's public key (raw 32-byte Ed25519, base64url): it signs only for `tenant`, as `iss` (OT2, I2). */
export type OpenTokenKey = { kid: string; publicKey: string; tenant: string; iss: string }

export type OpenTokenErrorCode = 'malformed' | 'version' | 'unknown-key' | 'signature' | 'issuer' | 'audience' | 'duplicate-key' | 'claims' | 'expired' | 'not-yet-valid'

export class OpenTokenError extends Error {
  constructor(readonly code: OpenTokenErrorCode) {
    super(`open token refused: ${code}`)
  }
}

const PERMS = ['edit', 'comment', 'download', 'share', 'export'] as const

/** Canonical unpadded base64url only, as the Rust crate reads it: anything else is `malformed`. */
function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new OpenTokenError('malformed')
  let bytes: Uint8Array
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    throw new OpenTokenError('malformed')
  }
  // Unused trailing bits must be zero: one encoding per byte string.
  if (toBase64Url(bytes) !== text) throw new OpenTokenError('malformed')
  return bytes
}

/**
 * Whether `json` is JSON a strict reader takes as the Rust crate does: no object key twice and no
 * number with a fraction or an exponent (claims hold integers only).
 */
function strictJson(json: string): boolean {
  let at = 0
  const space = () => {
    while (at < json.length && ' \t\n\r'.includes(json[at]!)) at += 1
  }
  const string = (): string | null => {
    if (json[at] !== '"') return null
    const start = at
    at += 1
    while (at < json.length && json[at] !== '"') at += json[at] === '\\' ? 2 : 1
    if (at >= json.length) return null
    at += 1
    try {
      return JSON.parse(json.slice(start, at)) as string
    } catch {
      return null
    }
  }
  const value = (depth: number): boolean => {
    if (depth > 8) return false
    space()
    const char = json[at]
    if (char === '{') {
      at += 1
      const keys = new Set<string>()
      space()
      if (json[at] === '}') {
        at += 1
        return true
      }
      for (;;) {
        space()
        const key = string()
        if (key === null || keys.has(key)) return false
        keys.add(key)
        space()
        if (json[at] !== ':') return false
        at += 1
        if (!value(depth + 1)) return false
        space()
        if (json[at] === ',') {
          at += 1
          continue
        }
        if (json[at] !== '}') return false
        at += 1
        return true
      }
    }
    if (char === '[') {
      at += 1
      space()
      if (json[at] === ']') {
        at += 1
        return true
      }
      for (;;) {
        if (!value(depth + 1)) return false
        space()
        if (json[at] === ',') {
          at += 1
          continue
        }
        if (json[at] !== ']') return false
        at += 1
        return true
      }
    }
    if (char === '"') return string() !== null
    const literal = /^(?:-?(?:0|[1-9][0-9]*)(?![.eE0-9])|true|false|null)/.exec(json.slice(at))
    if (!literal) return false
    at += literal[0].length
    return true
  }
  if (!value(0)) return false
  space()
  return at === json.length
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function split(token: string): [string, string] {
  if (typeof token !== 'string' || !token.startsWith(OPEN_TOKEN_PREFIX)) throw new OpenTokenError('malformed')
  const parts = token.slice(OPEN_TOKEN_PREFIX.length).split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new OpenTokenError('malformed')
  return [parts[0], parts[1]]
}

const isBool = (value: unknown): value is boolean => typeof value === 'boolean'
const isString = (value: unknown): value is string => typeof value === 'string'
const isSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Parses the segment into claims of the right shape (field types only; `checkClaims` checks values). */
function parseClaims(segment: string): OpenTokenClaims {
  let value: Record<string, unknown>
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(segment))
    if (!strictJson(json)) throw new OpenTokenError('malformed')
    value = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new OpenTokenError('malformed')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenTokenError('malformed')
  const perms = value.perms as Record<string, unknown> | null
  const permsOk = Boolean(perms) && typeof perms === 'object' && !Array.isArray(perms) && Object.keys(perms!).every((key) => (PERMS as readonly string[]).includes(key)) && PERMS.every((key) => isBool(perms![key]))
  const watermark = value.watermark ?? null
  const watermarkOk = watermark === null || (typeof watermark === 'object' && !Array.isArray(watermark) && Object.keys(watermark).length === 1 && isString((watermark as { text?: unknown }).text))
  // A missing name is empty; `null` is not a name (as the Rust crate reads it).
  const name = value.name === undefined ? '' : value.name
  const shaped =
    typeof value.v === 'number' &&
    isString(value.typ) &&
    ['kid', 'iss', 'aud', 'tenant', 'sub', 'file', 'version', 'doc_key'].every((key) => isString(value[key])) &&
    isString(name) &&
    permsOk &&
    watermarkOk &&
    isSeconds(value.iat) &&
    isSeconds(value.exp) &&
    (value.jti === undefined || value.jti === null || isString(value.jti))
  if (!shaped) throw new OpenTokenError('malformed')
  const claims = { ...value, name, watermark } as OpenTokenClaims
  if (value.jti === null) delete claims.jti
  return claims
}

/** Whether `tenant` is a tenant name: 2 to 40 lowercase letters, digits, and inner hyphens. */
export function isTenant(tenant: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(tenant)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const utf8Length = (text: string) => new TextEncoder().encode(text).length
const plain = (text: string, max: number) => text.length > 0 && utf8Length(text) <= max && !CONTROL.test(text)
const idLike = (text: string, extra: string) => text.length >= 1 && text.length <= 128 && new RegExp(`^[A-Za-z0-9._${extra}-]+$`).test(text)

function checkClaims(claims: OpenTokenClaims) {
  const ok =
    isTenant(claims.tenant) &&
    plain(claims.kid, 128) &&
    idLike(claims.iss, '') &&
    plain(claims.aud, 256) &&
    plain(claims.sub, 128) &&
    utf8Length(claims.name) <= 128 &&
    !CONTROL.test(claims.name) &&
    idLike(claims.file, ':') &&
    plain(claims.version, 128) &&
    idLike(claims.doc_key, '') &&
    (!claims.perms.edit || claims.perms.comment) &&
    (claims.watermark === null || plain(claims.watermark.text, 256)) &&
    (claims.jti === undefined || plain(claims.jti, 128))
  if (!ok) throw new OpenTokenError('claims')
}

function checkTime(claims: OpenTokenClaims, now: number) {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > OPEN_TOKEN_MAX_TTL) throw new OpenTokenError('expired')
  if (claims.iat > now + OPEN_TOKEN_CLOCK_SKEW) throw new OpenTokenError('not-yet-valid')
  if (now >= claims.exp) throw new OpenTokenError('expired')
}

/** Refuses a key set with two keys of one `(tenant, kid)` (I3), as the Rust crate's `HostKeys::new` does. */
export function checkOpenTokenKeys(keys: readonly OpenTokenKey[]) {
  const seen = new Set<string>()
  for (const key of keys) {
    const id = `${key.tenant}\u0000${key.kid}`
    if (seen.has(id)) throw new OpenTokenError('duplicate-key')
    seen.add(id)
  }
}

/** Verifies `token` for the server `audience` at `now` (Unix seconds) against `keys` (OT3, I2); throws `OpenTokenError`. */
export async function verifyOpenToken(token: string, keys: readonly OpenTokenKey[], audience: string, now = Math.floor(Date.now() / 1000)): Promise<OpenTokenClaims> {
  checkOpenTokenKeys(keys)
  const [segment, signature] = split(token)
  const claims = parseClaims(segment)
  if (claims.v !== 1 || claims.typ !== OPEN_TOKEN_TYPE) throw new OpenTokenError('version')
  const key = keys.find((candidate) => candidate.kid === claims.kid && candidate.tenant === claims.tenant)
  if (!key) throw new OpenTokenError('unknown-key')
  const raw = fromBase64Url(key.publicKey)
  const signatureBytes = fromBase64Url(signature)
  if (raw.length !== 32 || signatureBytes.length !== 64) throw new OpenTokenError('malformed')
  let valid = false
  try {
    const imported = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, imported, signatureBytes as BufferSource, new TextEncoder().encode(segment))
  } catch {
    valid = false
  }
  if (!valid) throw new OpenTokenError('signature')
  if (key.iss !== claims.iss) throw new OpenTokenError('issuer')
  if (claims.aud !== audience) throw new OpenTokenError('audience')
  checkClaims(claims)
  checkTime(claims, now)
  return claims
}

/**
 * The claims of `token` without checking its signature or times: for a page that shows what its
 * token says (the watermark, which buttons to offer), never for deciding what it allows.
 */
export function decodeOpenToken(token: string): OpenTokenClaims {
  return parseClaims(split(token)[0])
}

/** Whether `token` is an open token by its prefix (a `ks1.` sync token is not). */
export function isOpenToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(OPEN_TOKEN_PREFIX)
}

/** The Server principal of verified claims, `t:<tenant>:<iss>:<sub>` (I2). */
export function openTokenPrincipal(claims: Pick<OpenTokenClaims, 'tenant' | 'iss' | 'sub'>) {
  return `t:${claims.tenant}:${claims.iss}:${claims.sub}`
}

/** The sync role `perms` grant (OT1): `editor`, `commenter`, or `viewer`; never `owner`. */
export function openTokenRole(perms: OpenPerms): Exclude<Role, 'owner'> {
  return perms.edit ? 'editor' : perms.comment ? 'commenter' : 'viewer'
}

/**
 * The `doc_key` of `file`'s co-editing `generation` (section 1.3): the first 32 characters of
 * base64url(SHA-256("kition-doc-key\n" + file + "\n" + generation)).
 */
export async function deriveDocKey(file: string, generation: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`kition-doc-key\n${file}\n${generation}`))
  return toBase64Url(new Uint8Array(digest)).slice(0, 32)
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  )
}

/**
 * Signs `claims` (for a host server in Node: Kition One uses the Rust crate instead) with an
 * Ed25519 `privateKey` (a WebCrypto key with `sign`). `v`, `typ` and `kid` are set here; the
 * claims are checked first and written with sorted keys.
 */
export async function signOpenToken(claims: Omit<OpenTokenClaims, 'v' | 'typ' | 'kid'>, kid: string, privateKey: CryptoKey): Promise<string> {
  const full: OpenTokenClaims = { ...claims, v: 1, typ: OPEN_TOKEN_TYPE, kid }
  checkClaims(full)
  if (full.exp <= full.iat || full.exp - full.iat > OPEN_TOKEN_MAX_TTL) throw new OpenTokenError('expired')
  const segment = toBase64Url(new TextEncoder().encode(JSON.stringify(sortKeys(full))))
  let signature: Uint8Array
  try {
    signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(segment)))
  } catch {
    throw new OpenTokenError('signature')
  }
  return `${OPEN_TOKEN_PREFIX}${segment}.${toBase64Url(signature)}`
}

/**
 * What a kit host opens the kit with for a verified token (Kit UI protocol 2.6): read-only
 * without `edit`, comments without `comment`, the display permissions, and the watermark.
 */
export function openTokenDocument(claims: Pick<OpenTokenClaims, 'perms' | 'watermark'>) {
  const { perms } = claims
  return {
    readOnly: !perms.edit,
    canComment: perms.comment,
    permissions: { download: perms.download, export: perms.export, share: perms.share },
    watermark: claims.watermark ? { text: claims.watermark.text } : null,
  }
}
