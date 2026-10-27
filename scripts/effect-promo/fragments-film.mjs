import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { fragmentsFilm } from './fragments-recipe.mjs'
import { fragmentsAssets } from './fragments-assets.mjs'
import { decodeSamples, writeContactSheet } from './delivery.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.cache/effect-fragments')
const preview = process.argv.includes('--preview')
const media = await fragmentsAssets(root, output)
const asset = name => { const b = media.get(name); assert.ok(b, `Unlent asset: ${name}`); return b }
globalThis.kitionHost = { size: name => asset(name).length, readRange: (name, offset, length) => asset(name).subarray(offset, offset + length) }
const sdk = await import(pathToFileURL(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk.js')))
await sdk.default({ module_or_path: await fs.readFile(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk_bg.wasm')) })
const doc = sdk.EffectDocument.create('Kition-Fragments.keffect', 1280, 720), commands = []
const execute = (command, params = {}) => {
  try { const result = JSON.parse(doc.execute(command, JSON.stringify(params))); commands.push({ command, params }); return result }
  catch (error) { throw new Error(`${command} ${JSON.stringify(params)}: ${error}`) }
}
const hash = b => createHash('sha256').update(b).digest('hex')
const browser = await chromium.launch()
try {
  const recipe = fragmentsFilm(execute)
  execute('file.import', { paths: ['media/score.wav'], addToComp: true })
  const sound = execute('comp.info').layers[0].id
  execute('layer.rename', { layer: sound, name: 'audio.original-score' })
  execute('layer.setSwitch', { layers: [sound], switch: 'video', value: false })
  execute('layer.timing', { layers: [sound], in: 0, out: recipe.duration })
  assert.deepEqual(JSON.parse(doc.check()).diagnostics.filter(d => d.severity === 'error'), [])
  const render = time => { execute('time.set', { time }); return Buffer.from(doc.render(0, 0, 1, 1280, 720)) }
  const snapshots = recipe.checkpoints.map(time => ({ time, rgba: render(time) }))
  assert.equal(hash(render(recipe.hold[0])), hash(render(recipe.hold[1])), 'The closing lockup must hold still')
  const editable = Buffer.from(doc.save()), reopened = sdk.EffectDocument.open('Kition-Fragments.keffect', editable)
  try { for (const shot of snapshots) { reopened.execute('time.set', JSON.stringify({ time: shot.time })); assert.equal(hash(reopened.render(0, 0, 1, 1280, 720)), hash(shot.rgba)) } }
  finally { reopened.free() }
  const thumbs = shots => shots.map(s => {
    const rgba = Buffer.alloc(640 * 360 * 4)
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) s.rgba.copy(rgba, (y * 640 + x) * 4, (y * 2 * 1280 + x * 2) * 4, (y * 2 * 1280 + x * 2) * 4 + 4)
    return { ...s, rgba }
  })
  await writeContactSheet(browser, output, 'storyboard', thumbs(snapshots), { width: 640, height: 360 })
  await fs.writeFile(path.join(output, 'commands.json'), JSON.stringify(commands, null, 2))
  await fs.writeFile(path.join(output, 'recipe.json'), JSON.stringify(recipe, null, 2))
  console.log('PASS: native fracture, reverse remapping, reopen consistency, closing still hold.')
  if (!preview) {
    const api = new URL(process.env.KITION_API_URL ?? 'http://127.0.0.1:18102/api/v1/')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))
    const profile = path.join(os.homedir(), 'Library/Application Support/Kition')
    const token = (await fs.readFile(process.env.KITION_API_TOKEN_FILE ?? path.join(profile, 'data/api-token'), 'utf8')).trim()
    const workspace = JSON.parse(await fs.readFile(path.join(profile, 'workspaces.json'), 'utf8')).active_vault_path
    const folder = `Campaigns/Effect-Fragments-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
    const headers = { 'Kition-Token': token }
    const put = async (file, bytes) => {
      const url = new URL('kits/files', api); url.searchParams.set('path', `${folder}/${file}`)
      const response = await fetch(url, { method: 'PUT', headers, body: bytes }), result = await response.json()
      assert.equal(result.code, 200, result.message)
    }
    await put('media/material.svg', media.get('media/material.svg'))
    await fs.writeFile(path.join(workspace, folder, 'media/score.wav'), media.get('media/score.wav'), { flag: 'wx' })
    await put('Kition-Fragments.keffect', editable)
    console.log('Rendering 300 frames with native Effect H.264/AAC...')
    const start = performance.now(), before = Buffer.from(doc.save())
    const movie = Buffer.from(doc.renderMovie('Kition-Fragments.mp4', 'h264'))
    const renderSeconds = (performance.now() - start) / 1000
    assert.deepEqual(Buffer.from(doc.save()), before)
    const movieFile = path.join(output, 'Kition-Fragments.mp4')
    await fs.writeFile(movieFile, movie)
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', movieFile], { encoding: 'utf8' }))
    const video = metadata.streams.find(s => s.codec_type === 'video'), audio = metadata.streams.find(s => s.codec_type === 'audio')
    assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(Number(video.nb_read_frames), 300); assert.equal(video.r_frame_rate, '30/1'); assert.equal(audio.codec_name, 'aac')
    const decoded = decodeSamples(movieFile, snapshots, recipe)
    await writeContactSheet(browser, output, 'encoded-storyboard', thumbs(decoded), { width: 640, height: 360 })
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', movieFile, '-vn', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 5 * 1024 * 1024 })
    let energy = 0, peak = 0
    for (let i = 0; i < pcm.length; i += 4) { const v = pcm.readFloatLE(i); energy += v * v; peak = Math.max(peak, Math.abs(v)) }
    const rms = Math.sqrt(energy / (pcm.length / 4)); assert.ok(rms > .005 && peak < 1)
    await put('Kition-Fragments.mp4', movie)
    for (const [file, bytes] of [['Kition-Fragments.keffect', editable], ['Kition-Fragments.mp4', movie]]) {
      const saved = await fetch(new URL(`/workspace-files/${folder}/${file}`, api), { headers })
      assert.ok(saved.ok); assert.equal(hash(Buffer.from(await saved.arrayBuffer())), hash(bytes))
    }
    const report = { ...recipe, folder, renderSeconds, frames: 300, duration: metadata.format.duration, movieBytes: movie.length, movieSha256: hash(movie), projectSha256: hash(editable), audio: { rmsDbfs: 20 * Math.log10(rms), peakDbfs: 20 * Math.log10(peak), source: 'Original deterministic synthesis' }, samples: decoded.map(({ time, metrics }) => ({ time, ...metrics })) }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`PASS: native movie and host-saved editable project. ${folder}`)
  }
} finally { doc.free(); await browser.close() }
