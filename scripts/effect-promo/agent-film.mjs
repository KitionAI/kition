// Build a real product film with the packaged Effect engine. Project saves use the kit host.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { agentFilm } from './agent-film-recipe.mjs'
import { agentFilmAudio } from './agent-film-audio.mjs'
import { decodeSamples, writeContactSheet } from './delivery.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.cache/kition-agent-film')
const previewOnly = process.argv.includes('--preview')
const sourceFiles = {
  'symbol.svg': 'public/brand/kition-symbol.svg',
  'stage-light.svg': '.cache/kition-agent-film/media/stage-light.svg',
  'caption-shade.svg': '.cache/kition-agent-film/media/caption-shade.svg',
  'agent-review.webp': 'docs/readme/agent-document-diff-review.webp',
}
await fs.mkdir(path.join(output, 'media'), { recursive: true })
await fs.writeFile(path.join(output, 'media/stage-light.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><radialGradient id="g"><stop stop-color="#5645d4" stop-opacity=".55"/><stop offset="1" stop-color="#070f24" stop-opacity="0"/></radialGradient></defs><ellipse cx="1350" cy="450" rx="1100" ry="800" fill="url(#g)"/></svg>`)
await fs.writeFile(path.join(output, 'media/caption-shade.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070f24" stop-opacity="0"/><stop offset="1" stop-color="#070f24" stop-opacity=".98"/></linearGradient></defs><rect y="780" width="1920" height="300" fill="url(#g)"/></svg>`)
const media = new Map(await Promise.all(Object.entries(sourceFiles).map(async ([name, source]) => [`media/${name}`, await fs.readFile(path.join(root, source))])))
const music = await agentFilmAudio(root, output)
media.set('media/score.wav', music.wav)
// The Node host lends only the campaign's allowlisted media to the WASM engine.
const asset = name => { const bytes = media.get(name); if (!bytes) throw new Error(`Unlent campaign asset: ${name}`); return bytes }
globalThis.kitionHost = { size: name => asset(name).length, readRange: (name, offset, length) => new Uint8Array(asset(name).subarray(offset, offset + length)) }
const sdk = await import(pathToFileURL(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk.js')).href)
await sdk.default({ module_or_path: await fs.readFile(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk_bg.wasm')) })
const doc = sdk.EffectDocument.create('Kition-Agent-Film.keffect', 1920, 1080)
const steps = []
const execute = (command, params = {}) => {
  try {
    const result = JSON.parse(doc.execute(command, JSON.stringify(params)))
    steps.push({ command, params })
    return result
  } catch (error) { throw new Error(`${command}: ${JSON.stringify(params)}: ${error}`) }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const browser = await chromium.launch()
try {
  const recipe = agentFilm(execute)
  execute('file.import', { paths: ['media/score.wav'], addToComp: true, sequence: false })
  const sound = execute('comp.info').layers[0].id
  execute('layer.rename', { layer: sound, name: 'soundtrack.original-score' })
  execute('layer.setSwitch', { layers: [sound], switch: 'video', value: false })
  execute('layer.timing', { layers: [sound], in: 0, out: recipe.duration })
  assert.deepEqual(JSON.parse(doc.check()).diagnostics.filter(item => item.severity === 'error'), [])
  const info = execute('comp.info')
  assert.equal(new Set(info.layers.map(layer => layer.name)).size, info.layers.length)
  const render = (time, zoom = 1) => {
    execute('time.set', { time })
    return Buffer.from(doc.render(0, 0, zoom, recipe.width * zoom, recipe.height * zoom))
  }
  const snapshots = recipe.checkpoints.map(time => ({ time, rgba: render(time) }))
  assert.equal(new Set(snapshots.map(item => hash(item.rgba))).size, snapshots.length)
  const thumbs = recipe.checkpoints.map(time => ({ time, rgba: render(time, 1 / 3) }))
  await writeContactSheet(browser, output, 'storyboard', thumbs, { width: 640, height: 360, orientation: 'landscape' })
  const editable = Buffer.from(doc.save())
  const reopened = sdk.EffectDocument.open('Kition-Agent-Film.keffect', editable)
  try {
    for (const { time, rgba } of snapshots) {
      reopened.execute('time.set', JSON.stringify({ time }))
      assert.equal(hash(reopened.render(0, 0, 1, recipe.width, recipe.height)), hash(rgba), 'Reopened project must relink screenshots and reproduce the frame')
    }
  } finally { reopened.free() }
  await fs.writeFile(path.join(output, 'storyboard.json'), JSON.stringify({ ...recipe, sources: sourceFiles, music: { bpm: music.bpm, provenance: music.provenance } }, null, 2))
  await fs.writeFile(path.join(output, 'commands.json'), JSON.stringify(steps, null, 2))
  await fs.writeFile(path.join(output, 'brief.json'), JSON.stringify({ task: 'A twelve-second Kition agent product film', mode: 'single-shot adaptation', productClaims: ['Agent edits files', 'User reviews file changes'], sources: sourceFiles, palette: { primary: '#5645d4', canvas: '#070f24', ink: '#ffffff' }, font: 'Inter', motion: recipe.reference, soundtrack: 'Timed transition and physical switch sound effects; no background music', limitations: ['Task trace is a condensed reveal of a genuine screenshot, not a live recording', 'No measured velocity blur or depth of field', 'Hero navy is a marketing stage; original product capture retains its dark appearance'] }, null, 2))
  console.log(`Built ${info.layers.length} editable layers across ${recipe.scenes.length} shots; preview: .cache/kition-agent-film/storyboard.png`)
  if (!previewOnly) {
    const api = new URL(process.env.KITION_API_URL ?? 'http://127.0.0.1:18102/api/v1/')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname), 'The kit host must be loopback')
    const dataHome = path.join(os.homedir(), 'Library/Application Support/Kition')
    const token = (await fs.readFile(process.env.KITION_API_TOKEN_FILE ?? path.join(dataHome, 'data/api-token'), 'utf8')).trim()
    const registry = JSON.parse(await fs.readFile(path.join(dataHome, 'workspaces.json'), 'utf8'))
    const workspace = process.env.KITION_CAMPAIGN_WORKSPACE ?? registry.active_vault_path
    const folder = `Campaigns/Kition-Agent-Film-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
    const headers = { 'Kition-Token': token }
    const putNew = async (relative, bytes) => {
      const url = new URL('kits/files', api); url.searchParams.set('path', `${folder}/${relative}`)
      const response = await fetch(url, { method: 'PUT', headers, body: bytes })
      const answer = await response.json()
      assert.equal(answer.code, 200, `Host save failed: ${answer.message}`)
    }
    for (const [name, bytes] of media) {
      if (name.endsWith('.wav')) continue
      await putNew(name, bytes)
    }
    // WAV is an ordinary media asset, not a kit document. The first host asset creates the folder.
    const destination = path.join(workspace, folder)
    assert.ok((await fs.stat(path.join(destination, 'media/symbol.svg'))).isFile(), 'The selected workspace must match the running host')
    await fs.writeFile(path.join(destination, 'media/score.wav'), music.wav, { flag: 'wx' })
    await putNew('Kition-Agent-Film.keffect', editable)
    const projectUrl = new URL(`/workspace-files/${folder}/Kition-Agent-Film.keffect`, api)
    const saved = await fetch(projectUrl, { headers })
    assert.ok(saved.ok)
    assert.equal(hash(Buffer.from(await saved.arrayBuffer())), hash(editable), 'Host-saved editable project bytes must match')
    console.log('Rendering 12 seconds at 1920 x 1080 with the Effect H.264/AAC encoder...')
    const before = Buffer.from(doc.save())
    const movie = Buffer.from(doc.renderMovie('Kition-Agent-Film.mp4', 'h264'))
    assert.deepEqual(Buffer.from(doc.save()), before)
    const movieFile = path.join(output, 'Kition-Agent-Film.mp4')
    await fs.writeFile(movieFile, movie)
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', movieFile], { encoding: 'utf8' }))
    const video = metadata.streams.find(item => item.codec_type === 'video')
    const audio = metadata.streams.find(item => item.codec_type === 'audio')
    assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(Number(video.nb_read_frames), 360)
    assert.equal(video.r_frame_rate, '30/1'); assert.equal(audio?.codec_name, 'aac')
    assert.ok(Math.abs(Number(metadata.format.duration) - 12) < .1)
    const decoded = decodeSamples(movieFile, snapshots, recipe)
    const reviewFrames = decoded.map(snapshot => {
      const rgba = Buffer.alloc(640 * 360 * 4)
      for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
        const source = ((y * 3 + 1) * recipe.width + x * 3 + 1) * 4
        snapshot.rgba.copy(rgba, (y * 640 + x) * 4, source, source + 4)
      }
      return { ...snapshot, rgba }
    })
    await writeContactSheet(browser, output, 'encoded-storyboard', reviewFrames, { width: 640, height: 360, orientation: 'landscape' })
    const signal = execFileSync('ffmpeg', ['-v', 'error', '-i', movieFile, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 })
    let energy = 0; let peak = 0
    for (let i = 0; i < signal.length; i += 4) { const v = signal.readFloatLE(i); energy += v * v; peak = Math.max(peak, Math.abs(v)) }
    const rms = Math.sqrt(energy / (signal.length / 4))
    assert.ok(rms > .005 && peak < 1, 'Decoded soundtrack must be audible and unclipped')
    await putNew('Kition-Agent-Film.mp4', movie)
    const report = { title: recipe.title, workspaceFolder: folder, width: video.width, height: video.height, duration: metadata.format.duration, frames: video.nb_read_frames, layers: info.layers.length, commands: steps.length, movieBytes: movie.length, movieSha256: hash(movie), editableSha256: hash(editable), audio: { codec: audio.codec_name, rmsDbfs: 20 * Math.log10(rms), peakDbfs: 20 * Math.log10(peak), provenance: music.provenance }, framesChecked: decoded.map(({ time, metrics }) => ({ time, ...metrics })), sources: sourceFiles }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`PASS: film, soundtrack, media relinking, decoded frames, host-saved project and movie. Workspace folder: ${folder}`)
  }
} finally { doc.free(); await browser.close() }
