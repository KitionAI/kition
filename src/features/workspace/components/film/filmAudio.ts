import type { KitEngine } from '@/features/kits/public'

const CHUNK_SECONDS = 0.5
const LOOKAHEAD_SECONDS = 1.2
const START_DELAY_SECONDS = 0.08

/**
 * Plays the sequence's sound: the Film engine mixes it (the SDK's `audio`
 * extra) in half-second chunks that are scheduled ahead on a WebAudio
 * context. The context's clock is the playback clock, so the picture follows
 * the sound.
 *
 * Make it inside the play gesture: WebKit (the desktop app's web view) starts
 * a context suspended and runs it only after `resume()` in a gesture. The
 * clock starts at once, on wall time, and moves to the audio clock when the
 * context runs, continuing from where wall time had got to.
 */
export class FilmAudioPlayer {
  private readonly context: AudioContext
  private readonly gain: GainNode
  private readonly from: number
  /** The context time at which `from` is heard; set when the context runs. */
  private audioOrigin: number | null = null
  private readonly wallOrigin: number
  private next: number
  private rate = 48_000
  private pumping = false
  private stopped = false

  constructor(from: number, muted: boolean) {
    this.from = from
    this.next = from
    this.wallOrigin = performance.now() + START_DELAY_SECONDS * 1000
    this.context = new AudioContext()
    this.gain = this.context.createGain()
    this.gain.gain.value = muted ? 0 : 1
    this.gain.connect(this.context.destination)
    this.context.addEventListener('statechange', () => this.anchor())
    // Inside the gesture: the only place WebKit lets a context start.
    void this.context.resume().catch(() => undefined)
    this.anchor()
  }

  /** Ties the audio clock to the time already played once the context runs. */
  private anchor() {
    if (this.audioOrigin != null || this.context.state !== 'running') return
    const played = Math.max(0, (performance.now() - this.wallOrigin) / 1000)
    this.audioOrigin = this.context.currentTime - played + (played > 0 ? 0 : START_DELAY_SECONDS)
  }

  /** Starts mixing and scheduling sound; the clock already runs. */
  async start(doc: KitEngine) {
    this.rate = await doc.invoke<number>('audioRate').catch(() => 48_000)
    void this.pump(doc)
  }

  /** The sequence time being heard now: the audio clock when the context runs, wall time until then. */
  now() {
    if (this.audioOrigin != null && this.context.state === 'running') return this.from + Math.max(0, this.context.currentTime - this.audioOrigin)
    return this.from + Math.max(0, (performance.now() - this.wallOrigin) / 1000)
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
        // Nothing to schedule against until the context runs; the picture keeps wall time meanwhile.
        if (!samples || this.stopped || this.audioOrigin == null) continue
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
        const when = this.audioOrigin + (at - this.from)
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
