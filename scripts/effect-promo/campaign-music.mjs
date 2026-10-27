// Original procedural score: 120 BPM, six four-second phrases, no sampled recordings.
export function campaignMusic(duration = 24) {
  const rate = 48000
  const samples = new Float64Array(duration * rate)
  const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67], [53, 57, 60, 64], [48, 55, 60, 64]]
  const frequency = midi => 440 * 2 ** ((midi - 69) / 12)
  function add(start, length, signal) {
    const first = Math.round(start * rate)
    for (let i = 0; i < length * rate && first + i < samples.length; i++) samples[first + i] += signal(i / rate)
  }
  let noise = 2037
  const random = () => { noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0; return noise / 2147483648 - 1 }
  for (const [bar, chord] of chords.entries()) {
    for (const note of chord) add(bar * 4, 4, t => .035 * Math.min(1, t / .2) * Math.min(1, (4 - t) / .6) * Math.sin(2 * Math.PI * frequency(note) * t))
    for (let step = 0; step < 16; step++) {
      const start = bar * 4 + step * .25
      const f = frequency(chord[step % 4] + 12)
      add(start, .55, t => .09 * Math.min(1, t / .008) * Math.exp(-t * 9) * (Math.sin(2 * Math.PI * f * t) + .22 * Math.sin(2 * Math.PI * f * 2 * t)))
      if (bar < 5 || step < 8) add(start, .04, t => .018 * Math.exp(-t * 85) * random())
      if (step % 4 === 0 && (bar < 5 || step < 8)) add(start, .24, t => .16 * Math.exp(-t * 17) * Math.sin(2 * Math.PI * (48 * t + 4 * (1 - Math.exp(-t * 25)))))
      if (step % 4 === 2 && bar < 5) add(start, .1, t => .025 * Math.exp(-t * 40) * random())
    }
  }
  const wav = Buffer.alloc(44 + samples.length * 4)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const fade = Math.min(1, i / rate / .3, (duration - i / rate) / 1.4)
    const value = Math.tanh(samples[i] * 1.5) * .7 * fade
    peak = Math.max(peak, Math.abs(value))
    const sample = Math.round(value * 32767)
    wav.writeInt16LE(sample, 44 + i * 4); wav.writeInt16LE(sample, 46 + i * 4)
  }
  return { wav, peakDbfs: 20 * Math.log10(peak), bpm: 120, provenance: 'Original synthesized composition; no third-party recordings' }
}
