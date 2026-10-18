/**
 * Reads the files of a zip archive (stored or deflated entries), enough to install an extension
 * packed as one. Decompression uses the platform's `DecompressionStream`.
 */

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

export type ZipEntry = { name: string; read: () => Promise<Uint8Array> }

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const stream = input.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The entries of `archive`, by name; throws when it is not a zip archive this reader supports. */
export function readZip(archive: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  // The end-of-directory record is in the last 64 KiB + 22 bytes (its comment comes after it).
  let end = -1
  for (let offset = archive.byteLength - 22; offset >= Math.max(0, archive.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_DIRECTORY) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('not a zip archive')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== DIRECTORY_ENTRY) throw new Error('the zip archive is damaged')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`${name} is encrypted`)
    if (method !== 0 && method !== 8) throw new Error(`${name} uses a compression this reader does not support`)
    entries.set(name, {
      name,
      read: async () => {
        if (local + 30 > archive.byteLength || view.getUint32(local, true) !== LOCAL_HEADER) throw new Error('the zip archive is damaged')
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
        const data = archive.subarray(start, start + compressedSize)
        const bytes = method === 0 ? data.slice() : await inflate(data)
        if (bytes.byteLength !== size) throw new Error(`${name} is damaged`)
        return bytes
      },
    })
  }
  return entries
}
