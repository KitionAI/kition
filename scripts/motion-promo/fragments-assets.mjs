import fs from 'node:fs/promises'
import path from 'node:path'

export async function fragmentsAssets(root, output) {
  await fs.mkdir(path.join(output, 'media'), { recursive: true })
  const source = await fs.readFile(path.join(root, 'public/brand/kition-symbol.svg'), 'utf8')
  const mark = source.slice(source.indexOf('<rect'), source.lastIndexOf('</svg>')).replaceAll('#5645d4', '#ffffff')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><radialGradient id="stage"><stop stop-color="#14162e"/><stop offset="1" stop-color="#070f24"/></radialGradient><linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#b8a9ff"/><stop offset=".4" stop-color="#7968eb"/><stop offset="1" stop-color="#5645d4"/></linearGradient></defs><rect width="1280" height="720" fill="url(#stage)"/><rect x="480" y="200" width="320" height="320" rx="45" fill="url(#metal)"/><rect x="481" y="201" width="318" height="318" rx="44" fill="none" stroke="#d4caff" stroke-opacity=".5"/><g transform="translate(508 228) scale(1.03125)">${mark}</g></svg>`
  await fs.writeFile(path.join(output, 'media/material.svg'), svg)

  // Original deterministic score: low pulse, accelerating reverse-air sweep, impact and decay.
  const rate = 48000, duration = 10, frames = rate * duration, samples = new Float64Array(frames * 2)
  let seed = 7719, lowNoise = 0
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 }
  for (let i = 0; i < frames; i++) {
    const t = i / rate, n = noise(); lowNoise = lowNoise * .96 + n * .04
    const fade = Math.min(1, t / .5) * Math.min(1, (duration - t) / 1.8)
    const pulse = .045 * (1 + .28 * Math.sin(2 * Math.PI * 1.5 * t)) * Math.sin(2 * Math.PI * 55 * t)
    const air = t < 4 ? .13 * (t / 4) ** 3 * lowNoise : 0
    const hitTime = t - 4
    const hit = hitTime >= 0 ? .48 * Math.exp(-hitTime * 7) * Math.sin(2 * Math.PI * (47 * hitTime + 4 * (1 - Math.exp(-hitTime * 18)))) + .18 * Math.exp(-hitTime * 19) * n : 0
    const shimmer = hitTime >= 0 ? .04 * Math.exp(-hitTime * .8) * (Math.sin(2 * Math.PI * 440 * hitTime) + .5 * Math.sin(2 * Math.PI * 660 * hitTime)) : 0
    const v = (pulse + air + hit + shimmer) * fade
    samples[i * 2] = v
    samples[i * 2 + 1] = v * .94 + .008 * lowNoise * fade
  }
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0), gain = .74 / peak
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(samples[i] * gain * 32767), 44 + i * 2)
  await fs.writeFile(path.join(output, 'media/score.wav'), wav)
  await fs.writeFile(path.join(output, 'assets.json'), JSON.stringify({ material: { source: 'public/brand/kition-symbol.svg', treatment: 'Original vector material and gradient, canonical symbol geometry' }, audio: { source: 'Original deterministic synthesis', license: 'Apache-2.0', cues: [{ at: 0, type: 'Low pulse' }, { at: 2.8, type: 'Rising filtered air' }, { at: 4, type: 'Bass impact and harmonic decay' }] } }, null, 2))
  return new Map([['media/material.svg', Buffer.from(svg)], ['media/score.wav', wav]])
}
