/**
 * Lent files, the worker side: `globalThis.kitionHost`, which a kit SDK's Rust
 * code calls through `kition_sdk::host` to read the other files a document
 * refers to (a film project's media). Reads are synchronous, as the engine
 * needs them, which workers allow: ranged XMLHttpRequests against the host's
 * file URL, cached in 1 MiB chunks so a long video is read once and in pieces.
 * Errors are thrown as plain strings so the message reaches Rust.
 */

/** Where lent files come from: the workspace root URL, and the document's folder inside it. */
export type LentFiles = { root: string; folder: string }

const CHUNK = 1 << 20
const CACHE_BUDGET = 256 << 20

/** A workspace path for `file`, named by the document: relative to its folder, never above the root. */
export function resolveLentPath(folder: string, file: string) {
  if (!file.trim() || file.endsWith('/')) throw `${file || 'an empty path'} names no file`
  const parts: string[] = []
  const start = file.startsWith('/') ? [] : folder.split('/')
  for (const part of [...start, ...file.split('/')]) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw `${file} is outside the workspace`
      parts.pop()
    } else parts.push(part)
  }
  if (!parts.length) throw `${file} names no file`
  return parts.join('/')
}

function request(method: 'GET' | 'HEAD', url: string, range?: [number, number]) {
  const xhr = new XMLHttpRequest()
  xhr.open(method, url, false)
  xhr.responseType = 'arraybuffer'
  if (range) xhr.setRequestHeader('Range', `bytes=${range[0]}-${range[1]}`)
  try {
    xhr.send()
  } catch {
    throw `could not read ${url}`
  }
  return xhr
}

/** Installs `globalThis.kitionHost` for one open document; `null` lends nothing. */
export function lendFiles(lent: LentFiles | null) {
  const sizes = new Map<string, number>()
  const chunks = new Map<string, Uint8Array>()
  let cached = 0

  const url = (file: string) => {
    if (!lent) throw 'this host lends no files'
    return new URL(resolveLentPath(lent.folder, file).split('/').map(encodeURIComponent).join('/'), lent.root).href
  }

  const size = (file: string) => {
    const target = url(file)
    const known = sizes.get(target)
    if (known != null) return known
    const head = request('HEAD', target)
    if (head.status === 404) throw `${file} is not in the workspace`
    if (head.status >= 400) throw `${file}: HTTP ${head.status}`
    const length = Number(head.getResponseHeader('Content-Length'))
    if (!Number.isFinite(length) || length < 0) throw `${file}: the host reported no size`
    sizes.set(target, length)
    return length
  }

  const chunk = (target: string, file: string, index: number, total: number) => {
    const key = `${index}:${target}`
    const hit = chunks.get(key)
    if (hit) {
      // Most recently used last.
      chunks.delete(key)
      chunks.set(key, hit)
      return hit
    }
    const first = index * CHUNK
    const last = Math.min(total, first + CHUNK) - 1
    const response = request('GET', target, [first, last])
    if (response.status !== 206 && response.status !== 200) throw `${file}: HTTP ${response.status}`
    let bytes = new Uint8Array(response.response as ArrayBuffer)
    // A server that ignores Range sends the whole file.
    if (response.status === 200) bytes = bytes.slice(first, last + 1)
    chunks.set(key, bytes)
    cached += bytes.byteLength
    for (const [oldest, value] of chunks) {
      if (cached <= CACHE_BUDGET) break
      chunks.delete(oldest)
      cached -= value.byteLength
    }
    return bytes
  }

  const readRange = (file: string, offset: number, length: number) => {
    const target = url(file)
    const total = size(file)
    const end = Math.min(total, offset + length)
    const out = new Uint8Array(Math.max(0, end - offset))
    for (let position = offset; position < end;) {
      const index = Math.floor(position / CHUNK)
      const bytes = chunk(target, file, index, total)
      const from = position - index * CHUNK
      const count = Math.min(bytes.byteLength - from, end - position)
      if (count <= 0) throw `${file} is shorter than the host said`
      out.set(bytes.subarray(from, from + count), position - offset)
      position += count
    }
    return out
  }

  ;(globalThis as { kitionHost?: unknown }).kitionHost = { size, readRange }
}
