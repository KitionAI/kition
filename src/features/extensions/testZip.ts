/** Writes a zip archive (tests): each file stored, or deflated with `deflate`. */
export async function makeZip(files: Record<string, string>, deflate = false): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = encoder.encode(text)
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw)
        controller.close()
      },
    })
    const data = deflate ? new Uint8Array(await new Response(input.pipeThrough(new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer()) : raw
    const nameBytes = encoder.encode(name)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(8, deflate ? 8 : 0, true)
    local.setUint32(18, data.byteLength, true)
    local.setUint32(22, raw.byteLength, true)
    local.setUint16(26, nameBytes.byteLength, true)
    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(10, deflate ? 8 : 0, true)
    central.setUint32(20, data.byteLength, true)
    central.setUint32(24, raw.byteLength, true)
    central.setUint16(28, nameBytes.byteLength, true)
    central.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    directory.push(new Uint8Array(central.buffer), nameBytes)
    offset += 30 + nameBytes.byteLength + data.byteLength
  }
  const size = directory.reduce((sum, part) => sum + part.byteLength, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...directory, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
