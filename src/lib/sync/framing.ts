// Copied from kition-sdk packages/sync/src/framing.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The wire framing: a JSON text frame carries a message whose `bins` field says how many binary
 * frames follow it, each a payload one of the message's `{"$bin": n}` markers points to. Mirrors
 * `kition-sync-protocol`'s Rust `framing` module; this side builds and reads the markers rather
 * than typed `Bin` fields, since params and results here already carry real `Uint8Array`s.
 */

export type Frame = string | Uint8Array

export type Bin = { $bin: number }

export function isBin(value: unknown): value is Bin {
  return typeof value === 'object' && value !== null && typeof (value as { $bin?: unknown }).$bin === 'number'
}

/** Registers binary payloads as a message is built, handing out the `Bin` marker for each. */
export class Outgoing {
  private readonly bins: Uint8Array[] = []

  bin(data: Uint8Array): Bin {
    const index = this.bins.length
    this.bins.push(data)
    return { $bin: index }
  }

  /** The text frame first, then each registered payload as a binary frame, in order. */
  finish(message: Record<string, unknown>): Frame[] {
    const withCount = this.bins.length > 0 ? { ...message, bins: this.bins.length } : message
    return [JSON.stringify(withCount), ...this.bins]
  }
}

/** Reassembles an incoming stream of frames into complete messages; feed one frame at a time. */
export class Decoder {
  private pendingMessage: unknown
  private remaining = 0
  private collected: Uint8Array[] = []

  /** Returns the completed message once every binary frame it declared has arrived. Throws on
   * a frame out of sequence (never corrupts state the caller could keep feeding). */
  feed(frame: Frame): { message: Record<string, unknown>; bins: Uint8Array[] } | undefined {
    return typeof frame === 'string' ? this.feedText(frame) : this.feedBinary(frame)
  }

  private feedText(text: string): { message: Record<string, unknown>; bins: Uint8Array[] } | undefined {
    if (this.remaining > 0) throw new Error('a text frame arrived before the previous message received all its binary frames')
    const message = JSON.parse(text) as Record<string, unknown>
    const declared = typeof message.bins === 'number' && message.bins >= 0 ? message.bins : 0
    if (declared === 0) return { message, bins: [] }
    this.pendingMessage = message
    this.remaining = declared
    this.collected = []
    return undefined
  }

  private feedBinary(data: Uint8Array): { message: Record<string, unknown>; bins: Uint8Array[] } | undefined {
    if (this.remaining === 0) throw new Error('a binary frame arrived with no message awaiting one')
    this.collected.push(data)
    this.remaining -= 1
    if (this.remaining > 0) return undefined
    const message = this.pendingMessage as Record<string, unknown>
    const bins = this.collected
    this.pendingMessage = undefined
    this.collected = []
    return { message, bins }
  }
}

/** Resolves one `Bin` marker against a decoded message's binary frames. */
export function readBin(value: unknown, bins: Uint8Array[]): Uint8Array {
  if (!isBin(value)) throw new Error('expected a {"$bin": n} marker')
  const data = bins[value.$bin]
  if (!data) throw new Error(`binary frame ${value.$bin} is missing`)
  return data
}

export function readBins(values: unknown, bins: Uint8Array[]): Uint8Array[] {
  if (!Array.isArray(values)) throw new Error('expected an array of {"$bin": n} markers')
  return values.map((value) => readBin(value, bins))
}
