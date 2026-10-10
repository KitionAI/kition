import type { KitEngine } from '@/features/kits/public'

const CHUNK_SECONDS = 0.5
const LOOKAHEAD_SECONDS = 1.2
const START_DELAY_SECONDS = 0.08

/**
 * Plays the sequence's sound: the Film engine mixes it (the SDK's `audio`
 * extra) in half-second chunks that are scheduled ahead on a WebAudio
 * context. The context's clock is the playback clock, so the picture follows
 * the sound. Create it inside the play gesture; browsers start audio only there.
 */
export class FilmAudioPlayer {
  private readonly context: AudioContext
  private readonly gain: GainNode
  private startedAt = 0
  private startedAtWall = 0
  private from = 0
  private next = 0
  private rate = 48_000
  private pumping = false
  private stopped = false

  constructor(muted: boolean) {
    this.context = new AudioContext()
    this.gain = this.context.createGain()
    this.gain.gain.value = muted ? 0 : 1
    this.gain.connect(this.context.destination)
  }

  async start(doc: KitEngine, from: number) {
    this.rate = await doc.invoke<number>('audioRate').catch(() => 48_000)
    this.from = from
    this.next = from
    this.startedAt = this.context.currentTime + START_DELAY_SECONDS
    this.startedAtWall = performance.now() + START_DELAY_SECONDS * 1000
    void this.pump(doc)
  }

  /** The sequence time being heard now; wall-clock time while the context cannot play (no device). */
  now() {
    if (this.context.state !== 'running') return this.from + Math.max(0, (performance.now() - this.startedAtWall) / 1000)
    return this.from + Math.max(0, this.context.currentTime - this.startedAt)
  }

  setMuted(muted: boolean) {
    this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.02)
  }

  /** Keeps about a second of sound scheduled ahead of the clock. */
  private async pump(doc: KitEngine) {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.stopped && this.next < this.now() + LOOKAHEAD_SECONDS) {
        const frames = Math.round(CHUNK_SECONDS * this.rate)
        const at = this.next
        this.next += CHUNK_SECONDS
        const samples = await doc.invoke<Float32Array>('audio', at, frames).catch(() => null)
        if (!samples || this.stopped) continue
        const buffer = this.context.createBuffer(2, frames, this.rate)
        const left = buffer.getChannelData(0)
        const right = buffer.getChannelData(1)
        for (let index = 0; index < frames; index += 1) {
          left[index] = samples[index * 2] ?? 0
          right[index] = samples[index * 2 + 1] ?? 0
        }
        const source = this.context.createBufferSource()
        source.buffer = buffer
        source.connect(this.gain)
        const when = this.startedAt + (at - this.from)
        // A chunk that arrives late plays its remaining part, so the sound never drifts.
        const late = Math.max(0, this.context.currentTime - when)
        if (late < CHUNK_SECONDS) source.start(when + late, late)
      }
    } finally {
      this.pumping = false
    }
    if (!this.stopped) window.setTimeout(() => void this.pump(doc), (CHUNK_SECONDS * 1000) / 2)
  }

  stop() {
    this.stopped = true
    void this.context.close().catch(() => undefined)
  }
}
