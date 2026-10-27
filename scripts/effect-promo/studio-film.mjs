import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { studioFilm } from './studio-recipe.mjs'
import { studioAssets } from './studio-assets.mjs'
import { decodeSamples } from './delivery.mjs'
import { inspectMovie, writeComparison } from './studio-review.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.cache/effect-studio-v3')
const preview = process.argv.includes('--preview')
const stills = process.argv.includes('--stills')
const media = await studioAssets(root, output)
const get = name => { const bytes = media.get(name); assert.ok(bytes, `Unlent media: ${name}`); return bytes }
globalThis.kitionHost = { size: name => get(name).length, readRange: (name, offset, length) => get(name).subarray(offset, offset + length) }
const sdk = await import(pathToFileURL(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk.js')))
await sdk.default({ module_or_path: await fs.readFile(path.join(root, 'public/kits/effect-ui/engine/kition_effect_sdk_bg.wasm')) })
const doc = sdk.EffectDocument.create('Kition-One-Brief.keffect', 1280, 720)
const commands = []
const run = (command, params = {}) => {
  try { const result = JSON.parse(doc.execute(command, JSON.stringify(params))); assert.equal(result?.errors?.length ?? 0, 0, JSON.stringify(result?.errors)); commands.push({ command, params }); return result }
  catch (error) { throw new Error(`${command} ${JSON.stringify(params)}: ${error}`) }
}
const hash = b => createHash('sha256').update(b).digest('hex')
async function gallery(name, shots) {
  const args = ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x360', '-r', '1', '-i', 'pipe:0']
  execFileSync('ffmpeg', [...args, '-y', path.join(output, `${name}-%d.png`)], { input: Buffer.concat(shots.map(s => s.rgba)), maxBuffer: 1024 * 1024 })
  execFileSync('ffmpeg', [...args, '-vf', `tile=2x${Math.ceil(shots.length / 2)}:padding=4:margin=4:color=white`, '-frames:v', '1', '-y', path.join(output, `${name}.png`)], { input: Buffer.concat(shots.map(s => s.rgba)), maxBuffer: 1024 * 1024 })
}
try {
  const recipe = studioFilm(run)
  run('file.import', { paths: ['media/score.wav'], addToComp: true })
  const sound = run('comp.info').layers[0].id
  run('layer.rename', { layer: sound, name: 'soundtrack.house-vibez-and-foley' })
  run('layer.setSwitch', { layers: [sound], switch: 'video', value: false })
  run('layer.timing', { layers: [sound], in: 0, out: recipe.duration })
  const diagnostics = JSON.parse(doc.check()).diagnostics
  assert.deepEqual(diagnostics.filter(d => d.severity === 'error'), [])
  const render = time => { run('time.set', { time }); return Buffer.from(doc.render(0, 0, 1, recipe.width, recipe.height)) }
  const snapshots = []
  for (const time of recipe.checkpoints) {
    const start = performance.now(), rgba = render(time)
    snapshots.push({ time, rgba })
    console.log(`Preview ${time}s: ${Math.round(performance.now() - start)} ms`)
  }
  const thumbs = shots => shots.map(s => {
    const rgba = Buffer.alloc(640 * 360 * 4)
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) s.rgba.copy(rgba, (y * 640 + x) * 4, (y * 2 * 1280 + x * 2) * 4, (y * 2 * 1280 + x * 2) * 4 + 4)
    return { ...s, rgba }
  })
  await gallery('storyboard', thumbs(snapshots))
  await fs.writeFile(path.join(output, 'commands.json'), JSON.stringify(commands, null, 2))
  await fs.writeFile(path.join(output, 'recipe.json'), JSON.stringify(recipe, null, 2))
  // Preview includes four samples per second so transitions can be inspected in motion.
  if (preview && !stills) {
    const raw = path.join(output, 'preview.rgba'), handle = await fs.open(raw, 'w')
    try { for (let f = 0; f < 480; f += 6) await handle.write(render(f / 24)) }
    finally { await handle.close() }
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-r', '4', '-i', raw, '-i', path.join(output, 'media/score.wav'), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', path.join(output, 'motion-preview.mp4')])
    await fs.unlink(raw)
    console.log('PASS: native scene previews ready.')
  } else if (!preview) {
    assert.equal(hash(render(recipe.hold[0])), hash(render(recipe.hold[1])), 'The closing geometry must settle')
    const editable = Buffer.from(doc.save()), reopened = sdk.EffectDocument.open('Kition-One-Brief.keffect', editable)
    try {
      for (const shot of [snapshots[0], snapshots[4], snapshots.at(-1)]) {
        reopened.execute('time.set', JSON.stringify({ time: shot.time }))
        assert.equal(hash(reopened.render(0, 0, 1, 1280, 720)), hash(shot.rgba))
      }
    } finally { reopened.free() }
    const api = new URL(process.env.KITION_API_URL ?? 'http://127.0.0.1:18102/api/v1/')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))
    const profile = path.join(os.homedir(), 'Library/Application Support/Kition')
    const token = (await fs.readFile(process.env.KITION_API_TOKEN_FILE ?? path.join(profile, 'data/api-token'), 'utf8')).trim()
    const workspace = JSON.parse(await fs.readFile(path.join(profile, 'workspaces.json'), 'utf8')).active_vault_path
    const folder = `Campaigns/Effect-One-Brief-v3-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
    const headers = { 'Kition-Token': token }
    const put = async (name, bytes) => {
      const u = new URL('kits/files', api); u.searchParams.set('path', `${folder}/${name}`)
      const response = await fetch(u, { method: 'PUT', headers, body: bytes }), answer = await response.json()
      assert.equal(answer.code, 200, answer.message)
    }
    for (const [name, bytes] of media) if (name.endsWith('.svg')) await put(name, bytes)
    // The score is an ordinary linked media file; the host creates its campaign directory.
    for (const [name, bytes] of media) if (!name.endsWith('.svg')) await fs.writeFile(path.join(workspace, folder, name), bytes, { flag: 'wx' })
    await put('Kition-One-Brief.keffect', editable)
    console.log('Rendering 480 frames with Effect native H.264/AAC...')
    const started = performance.now(), before = Buffer.from(doc.save())
    const movie = Buffer.from(doc.renderMovie('Kition-One-Brief.mp4', 'h264'))
    const renderSeconds = (performance.now() - started) / 1000
    assert.deepEqual(Buffer.from(doc.save()), before)
    const moviePath = path.join(output, 'Kition-One-Brief.mp4')
    await fs.writeFile(moviePath, movie)
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', moviePath], { encoding: 'utf8' }))
    const video = metadata.streams.find(s => s.codec_type === 'video'), audio = metadata.streams.find(s => s.codec_type === 'audio')
    assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(Number(video.nb_read_frames), 480)
    assert.equal(video.r_frame_rate, '24/1'); assert.equal(audio.codec_name, 'aac')
    assert.ok(Math.abs(Number(metadata.format.duration) - 20) < .1)
    const checked = decodeSamples(moviePath, snapshots, recipe)
    await gallery('encoded-storyboard', thumbs(checked))
    execFileSync('ffmpeg', ['-v', 'error', '-i', moviePath, '-f', 'null', '-'])
    await put('Kition-One-Brief.mp4', movie)
    for (const [name, bytes] of [['Kition-One-Brief.keffect', editable], ['Kition-One-Brief.mp4', movie]]) {
      const response = await fetch(new URL(`/workspace-files/${folder}/${name}`, api), { headers })
      assert.ok(response.ok); assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(bytes))
    }
    const continuity = inspectMovie(moviePath)
    await fs.writeFile(path.join(output, 'continuity.json'), JSON.stringify(continuity, null, 2))
    const { frames: frameMeasurements, ...quality } = continuity
    const report = { ...recipe, quality, folder, renderSeconds, movieBytes: movie.length, sha256: hash(movie), projectSha256: hash(editable), layers: run('comp.info').layers.length, diagnostics, samples: checked.map(({ time, metrics }) => ({ time, ...metrics })), soundtrack: JSON.parse(await fs.readFile(path.join(output, 'audio-provenance.json'), 'utf8')) }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    const html = `<!doctype html><meta charset="utf-8"><title>Kition - One brief, a whole team</title><style>body{margin:0;background:#f8f7fb;color:#282333;font:16px system-ui;padding:40px;max-width:1280px;margin:auto}video{width:100%;border-radius:12px;background:#eeebf2}h1{font-size:28px}a{color:#5645d4}.note{color:#736b83}</style><h1>Kition — One brief, a whole team</h1><video controls autoplay playsinline src="Kition-One-Brief.mp4"></video><p>20 seconds · 1280 × 720 · 24 fps · Native Effect render</p><p class="note">An illustrative product visualization. The same brief and three work objects form the final mark.</p><p><a href="Kition-One-Brief.mp4">Download film</a> · <a href="encoded-storyboard.png">View rendered frames</a> · <a href="report.json">Verification and sources</a></p>`
    await fs.writeFile(path.join(output, 'index.html'), html)
    await writeComparison(output, '../effect-studio-v2/Kition-One-Brief.mp4')
    console.log(`PASS: native movie, complete decode, sampled frames, reopened project, and host saves. ${folder}`)
  }
} finally { doc.free() }
