import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.cache/effect-fragments')
const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'))
await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fragments to focus | Kition Effect</title>
<style>*{box-sizing:border-box}body{margin:0;background:#070f24;color:#fff;font:16px/1.65 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:36px 28px}h1{font-size:40px;letter-spacing:-1px;line-height:1.1;margin:12px 0}p{color:#b8bdd1}.eyebrow{color:#a99dec;font-size:12px;letter-spacing:2px}.grid{display:grid;grid-template-columns:3fr 1fr;gap:24px;margin:26px 0}video{display:block;width:100%;background:#070f24;border:1px solid #333854;border-radius:12px}aside{border:1px solid #333854;border-radius:12px;padding:18px}aside img{display:block;width:100%;border-radius:8px}h2{font-size:18px;margin:0 0 12px}button{background:#5645d4;color:white;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}button.secondary{background:#252a42}nav{display:flex;gap:10px;margin:16px 0;flex-wrap:wrap}a{color:#c2b7ff}.note{font-size:14px;border-top:1px solid #333854;padding-top:18px}li{color:#b8bdd1}small{color:#919ab7}@media(max-width:850px){.grid{grid-template-columns:1fr}h1{font-size:32px}}</style>
<main><div class="eyebrow">KITION EFFECT / NATIVE COMPOSITING STUDY</div><h1>From fragments to focus.</h1><p>One vector plate. Procedural fracture, perspective and light. A reverse simulation brings it together.</p>
<div class="grid"><section><video id="film" controls playsinline preload="auto" poster="storyboard-4.png" src="Kition-Fragments.mp4"></video><nav><button data-time="0">Play the film</button><button data-time="2.8" class="secondary">Watch the assembly</button><button data-time="6.6" class="secondary">Watch the lockup</button></nav><small>10 seconds · 1280 × 720 · 30 fps · original sound design</small></section><aside><h2>The input artwork</h2><img src="media/material.svg" alt="Original flat Kition vector plate"><p>This single still image supplies the surface texture. Effect generates the moving pieces.</p><a href="media/material.svg">Open the original SVG</a></aside></div>
<h2>What Effect contributes</h2><ul><li>Native Shatter: fragments with thickness, force, mass, rotation and perspective.</li><li>Camera and lighting inside the simulation, with clean artwork restored at rest.</li><li>Reverse time remapping, Glow, Lens Flare and Screen compositing.</li><li>An editable project and native H.264/AAC output.</li></ul>
<p class="note">This demonstrates a built-in compositing workflow, not a limitation of browser graphics. <a href="https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API">WebGL</a> can also render this class of scene. A plain HTML/CSS workflow would need additional geometry, lighting and rendering machinery. No token-cost or render-speed advantage has been measured here.</p>
<p><a href="Kition-Fragments.mp4">Download MP4</a> · <a href="storyboard.png">View the storyboard</a> · <a href="report.json">Read the validation report</a></p><small>Editable project in the Kition workspace: ${report.folder}/Kition-Fragments.keffect</small></main>
<script>const v=document.getElementById('film');document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{v.currentTime=Number(b.dataset.time);v.play().catch(()=>{})});</script></html>`)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.goto(`file://${path.join(output, 'index.html')}`)
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2)
  await page.locator('[data-time="2.8"]').click()
  await page.waitForTimeout(1300)
  const playback = await page.locator('video').evaluate(v => ({ time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, error: v.error?.message ?? null, rate: v.playbackRate }))
  assert.ok(playback.time > 3.5 && playback.frames > 10 && !playback.error && playback.rate === 1)
  await page.locator('video').evaluate(v => { v.pause(); v.currentTime = 8.5 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(output, 'review-page.png'), fullPage: true })
  await fs.writeFile(path.join(output, 'playback.json'), JSON.stringify(playback, null, 2))
  console.log('PASS: review page plays the native movie and seeks to the assembly.')
} finally { await browser.close() }
