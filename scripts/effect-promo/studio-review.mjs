import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Inspect every decoded frame, including the transitions between storyboard samples.
export function inspectMovie(movie) {
  const pixels = 320 * 180
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', movie, '-vf', 'scale=320:180', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: pixels * 500 })
  assert.equal(raw.length, pixels * 480)
  let previous, repeated = 0, longestRepeat = 0
  const frames = []
  for (let f = 0; f < 480; f++) {
    const current = raw.subarray(f * pixels, (f + 1) * pixels)
    let sum = 0, squared = 0, difference = 0
    for (let p = 0; p < pixels; p++) {
      sum += current[p]; squared += current[p] ** 2
      if (previous) difference += Math.abs(current[p] - previous[p])
    }
    const mean = sum / pixels, deviation = Math.sqrt(squared / pixels - mean ** 2)
    assert.ok(mean > 8 && deviation > 3, `Empty or black frame at ${f}`)
    if (f < 420) {
      repeated = difference === 0 ? repeated + 1 : 0
      longestRepeat = Math.max(repeated, longestRepeat)
    }
    frames.push({ frame: f, mean, deviation, difference: difference / pixels })
    previous = current
  }
  assert.ok(longestRepeat < 12, 'Unexpected half-second freeze before the closing hold')
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', movie, '-vn', '-ar', '12000', '-ac', '2', '-f', 'f32le', 'pipe:1'], { maxBuffer: 24000 * 4 * 22 })
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
  let peak = 0
  const rmsPerSecond = []
  for (let second = 0; second < 20; second++) {
    let squared = 0
    const window = samples.subarray(second * 24000, (second + 1) * 24000)
    for (const sample of window) { squared += sample ** 2; peak = Math.max(peak, Math.abs(sample)) }
    rmsPerSecond.push(Math.sqrt(squared / window.length))
  }
  assert.ok(peak < .99, 'Decoded audio reaches clipping level')
  assert.ok(rmsPerSecond.slice(1, 18).every(rms => rms > .005), 'Unexpected silent music section')
  assert.ok(rmsPerSecond[19] < rmsPerSecond[17], 'The score must resolve with a fade')
  return { checkedFrames: frames.length, longestRepeatedRunBeforeHold: longestRepeat,
    maximumAdjacentDifference: Math.max(...frames.map(f => f.difference)),
    minimumFrameDeviation: Math.min(...frames.map(f => f.deviation)),
    audio: { channels: 2, peak, rmsPerSecond }, frames }
}

export async function writeComparison(output, before = '../effect-studio/Kition-One-Brief.mp4') {
  try { await fs.access(path.resolve(output, before)) } catch { return }
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kition film — revision comparison</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fafaf9;color:#282333;font:16px/1.5 system-ui;padding:32px;max-width:1600px;margin:auto}
h1{font-size:clamp(25px,4vw,36px);margin:0 0 8px}p{color:#736b83;margin:0 0 24px}
.films{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;min-width:0}figcaption{font-weight:600;margin:0 0 8px}
video{display:block;width:100%;border-radius:12px;background:#f0eeec;border:1px solid #e5e3df}
.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:24px 0 16px}button,a{font:inherit}
button{border:1px solid #e5e3df;background:white;border-radius:8px;padding:9px 16px;cursor:pointer;min-height:44px}
button.primary{background:#5645d4;color:white;border-color:#5645d4}button:focus-visible,a:focus-visible{outline:3px solid #a99ce9;outline-offset:3px}
input{width:100%;accent-color:#5645d4}a{color:#5645d4}output{font-variant-numeric:tabular-nums}.links{display:flex;flex-wrap:wrap;gap:16px;margin-top:20px}
@media(max-width:700px){body{padding:20px 16px}.films{grid-template-columns:1fr}.controls{gap:8px}button{padding:8px 12px}}
</style>
<h1>One brief, a whole team</h1><p>Compare the previous film with the revised cut. Sound plays from the revised film.</p>
<div class="films"><figure><figcaption>Previous</figcaption><video id="before" muted playsinline preload="auto" src="${before}"></video></figure>
<figure><figcaption>Revised</figcaption><video id="after" playsinline preload="auto" src="Kition-One-Brief.mp4"></video></figure></div>
<div class="controls"><button class="primary" id="play">Play both</button><button id="restart">Restart</button><button id="back">Previous frame</button><button id="next">Next frame</button><output id="time">0.00 / 20.00 s</output></div>
<input id="seek" type="range" min="0" max="19.958333" step="0.0416667" value="0" aria-label="Video time">
<div class="controls" aria-label="Review moments"><button data-time="0.75">Opening</button><button data-time="6">Research</button><button data-time="8">Design</button><button data-time="10">Launch</button><button data-time="15.25">Logo transition</button><button data-time="18">Closing</button></div>
<div class="links"><a href="Kition-One-Brief.mp4">Open revised film</a><a href="encoded-storyboard.png">View frames</a><a href="report.json">Verification report</a></div>
<script>
const before=document.querySelector('#before'),after=document.querySelector('#after'),play=document.querySelector('#play'),seek=document.querySelector('#seek'),time=document.querySelector('#time');
function pause(){before.pause();after.pause();play.textContent='Play both'}
function jump(t){pause();before.currentTime=after.currentTime=Math.max(0,Math.min(479/24,t));update()}
function update(){seek.value=after.currentTime;time.textContent=after.currentTime.toFixed(2)+' / 20.00 s'}
play.onclick=async()=>{if(!after.paused)return pause();if(after.ended)jump(0);before.currentTime=after.currentTime;try{await Promise.all([before.play(),after.play()]);play.textContent='Pause both'}catch(e){pause();time.textContent='Playback unavailable: '+e.message}};
document.querySelector('#restart').onclick=()=>jump(0);document.querySelector('#back').onclick=()=>jump(after.currentTime-1/24);document.querySelector('#next').onclick=()=>jump(after.currentTime+1/24);
seek.oninput=()=>jump(Number(seek.value));document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>jump(Number(b.dataset.time)));
after.ontimeupdate=()=>{update();if(!after.paused&&Math.abs(before.currentTime-after.currentTime)>.08)before.currentTime=after.currentTime};after.onended=pause;
</script></html>`
  await fs.writeFile(path.join(output, 'compare.html'), html)
}
