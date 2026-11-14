import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export async function agentFilmAudio(root, output) {
  const library = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'skills/video-shotcraft/assets/audio/sfx')
  const cues = [
    { file: 'transition/air-zoom-vacuum.mp3', at: .05, duration: 1.5, gain: .17, url: 'https://assets.mixkit.co/active_storage/sfx/2608/2608-preview.mp3' },
    { file: 'transition/sweep-fast-small.mp3', at: 4.5, duration: .8, gain: .22, url: 'https://assets.mixkit.co/active_storage/sfx/166/166-preview.mp3' },
    { file: 'impact/bass-hit-short.mp3', at: 7.4, duration: 1.5, gain: .2, url: 'https://assets.mixkit.co/active_storage/sfx/2299/2299-preview.mp3' },
    { file: 'transition/air-zoom-vacuum.mp3', at: 9.25, duration: 1.7, gain: .14, url: 'https://assets.mixkit.co/active_storage/sfx/2608/2608-preview.mp3' },
  ]
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=12']
  for (const cue of cues) args.push('-i', path.join(library, cue.file))
  const filters = cues.map((cue, i) => `[${i + 1}:a]atrim=0:${cue.duration},asetpts=PTS-STARTPTS,afade=t=out:st=${cue.duration - .3}:d=0.3,volume=${cue.gain},adelay=${Math.round(cue.at * 1000)}:all=1[a${i}]`)
  filters.push(`[0:a]${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=5:normalize=0,alimiter=limit=.85:level=false:latency=true[out]`)
  const destination = path.join(output, 'media/score.wav')
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-t', '12', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', destination)
  execFileSync('ffmpeg', args)
  await fs.writeFile(path.join(output, 'audio-cues.json'), JSON.stringify({ license: 'Mixkit Sound Effects Free License', cues }, null, 2))
  return { wav: await fs.readFile(destination), provenance: 'Mixkit sound effects; sources and timed cues recorded in audio-cues.json' }
}
