// A production-workflow benchmark, not a reference-capture tool. No reference app is needed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { productLaunch, toolCalls } from './recipe.mjs'
import { assertFrame, compareFrame, decodeSamples, limits, writeContactSheet } from './delivery.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = path.join(root, '.cache/effect-promo')
// An external decoder checks the delivered container; it is never linked into the application.
execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
const packageDirectory = path.join(root, 'public/kits/effect-ui')
const wasm = await fs.readFile(path.join(packageDirectory, 'engine/kition_effect_sdk_bg.wasm'))
const sdk = await import(pathToFileURL(path.join(packageDirectory, 'engine/kition_effect_sdk.js')).href)
await sdk.default({ module_or_path: wasm })
const browser = await chromium.launch()
try {
  for (const [width, height] of [[640, 360], [360, 640]]) await verifyDelivery(width, height)
} finally { await browser.close() }

async function verifyDelivery(width, height) {
  const recipe = productLaunch({ width, height })
  const output = recipe.orientation === 'portrait' ? path.join(outputRoot, 'portrait') : outputRoot
  await fs.mkdir(output, { recursive: true })
  const calls = toolCalls(recipe, 'Launch.keffect')
  // Deliver full-resolution tool arguments separately; the benchmark renders a quick proof copy.
  await fs.writeFile(path.join(output, 'tool-calls.json'), JSON.stringify(toolCalls(productLaunch({ width: width * 3, height: height * 3 }), 'Launch.keffect'), null, 2))
  await fs.writeFile(path.join(output, 'storyboard.json'), JSON.stringify(recipe.scenes.map(({ steps, ...scene }) => scene), null, 2))
  const doc = sdk.EffectDocument.create('Launch.keffect', recipe.width, recipe.height)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const execute = (command, params = {}) => JSON.parse(doc.execute(command, JSON.stringify(params)))
  const frame = time => {
    execute('time.set', { time })
    return Buffer.from(doc.render(0, 0, 1, recipe.width, recipe.height))
  }
  try {
    assert.equal(JSON.parse(doc.inspect()).info.layers.length, 0, 'A new recipe starts in an empty composition')
    for (const call of calls) {
      assert.ok(call.arguments.steps.length <= 50, 'effect_run accepts at most 50 commands')
      for (const step of call.arguments.steps) execute(step.command, step.params)
      console.log(`Built ${call.scene}: ${call.arguments.steps.length} commands`)
    }
    const info = execute('comp.info')
    assert.equal(info.duration, recipe.duration)
    assert.equal(info.frameRate, recipe.frameRate)
    assert.equal(info.layers.length, recipe.layers.length)
    assert.equal(new Set(info.layers.map(layer => layer.name)).size, recipe.layers.length, 'Agent edit targets must be unique')
    for (const layer of recipe.layers) {
      const actual = info.layers.find(item => item.name === layer.name)
      // Timing commands snap to the composition frame grid.
      assert.ok(Math.abs(actual.in - layer.in) <= 0.5 / recipe.frameRate)
      assert.equal(actual.out, layer.out)
    }
    const snapshots = recipe.checkpoints.map(time => ({ time, rgba: frame(time) }))
    const transitions = recipe.transitionTimes.map(time => ({ time, rgba: frame(time) }))
    // Fade through the white composition background at each cut; check both sides too.
    for (let i = 0; i < transitions.length; i += 4) {
      const [exit, cut, entrance, settled] = transitions.slice(i, i + 4)
      assert.ok(cut.rgba.every(value => value === 255), `Cut at ${cut.time}s must be white`)
      assert.equal(new Set([exit, cut, entrance, settled].map(item => hash(item.rgba))).size, 4, 'A transition must contain distinct exit, cut, entrance, and settled frames')
    }
    const allSnapshots = [...snapshots, ...transitions].sort((a, b) => a.time - b.time)
    assert.equal(new Set(snapshots.slice(0, 4).map(snapshot => hash(snapshot.rgba))).size, 4, 'Each scene must show different content')
    for (const snapshot of snapshots) {
      const nonwhite = snapshot.rgba.filter((value, index) => index % 4 !== 3 && value < 220).length
      assert.ok(nonwhite > recipe.width * recipe.height * 0.01, `Scene at ${snapshot.time}s is blank`)
    }
    const saved = doc.save()
    const reopened = sdk.EffectDocument.open('Launch.keffect', saved)
    try {
      for (const snapshot of allSnapshots) {
        reopened.execute('time.set', JSON.stringify({ time: snapshot.time }))
        assert.equal(hash(reopened.render(0, 0, 1, recipe.width, recipe.height)), hash(snapshot.rgba), 'Save/reopen must preserve the delivered frame')
      }
    } finally { reopened.free() }

    // Simulate a focused agent revision: change one scene, leave the other shots alone, then undo.
    const before = hash(frame(10.5))
    execute('layer.setText', { layer: 'promo.closing.headline', text: 'Make your next move.' })
    assert.notEqual(hash(frame(10.5)), before, 'The requested revision must affect its target shot')
    assert.equal(hash(frame(1.5)), hash(snapshots[0].rgba), 'A targeted revision must not alter the opening')
    execute('edit.undo')
    assert.equal(hash(frame(10.5)), before, 'Undo must restore the previous creative version')
    assert.deepEqual(JSON.parse(doc.check()).diagnostics.filter(item => item.severity === 'error'), [], 'The delivery project must have no engine diagnostics at error severity')

    await writeContactSheet(browser, output, 'contact-sheet', snapshots, recipe)
    console.log('Rendering the 12-second proof movie...')
    const beforeMovie = Buffer.from(doc.save())
    const movie = Buffer.from(doc.renderMovie('Launch.mp4', 'h264'))
    assert.equal(movie.subarray(4, 8).toString(), 'ftyp')
    assert.deepEqual(Buffer.from(doc.save()), beforeMovie, 'Export must not mutate the editable project')
    await fs.writeFile(path.join(output, 'Launch.mp4'), movie)
    const encoded = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration',
      '-of', 'json', path.join(output, 'Launch.mp4'),
    ], { encoding: 'utf8' })).streams[0]
    assert.equal(encoded.codec_name, 'h264')
    assert.equal(encoded.width, recipe.width)
    assert.equal(encoded.height, recipe.height)
    assert.equal(encoded.r_frame_rate, `${recipe.frameRate}/1`)
    assert.equal(Number(encoded.nb_read_frames), recipe.duration * recipe.frameRate)
    assert.ok(Math.abs(Number(encoded.duration) - recipe.duration) < 1 / recipe.frameRate)
    const decoded = decodeSamples(path.join(output, 'Launch.mp4'), allSnapshots, recipe)
    // Negative controls prove that loss of content and a wrong scene cannot pass the tolerance.
    assert.throws(() => assertFrame(compareFrame(snapshots[0].rgba, snapshots[1].rgba), 'Wrong scene'))
    assert.throws(() => assertFrame(compareFrame(snapshots[0].rgba, Buffer.alloc(snapshots[0].rgba.length, 255)), 'Blank movie'))
    await writeContactSheet(browser, output, 'encoded-shots', decoded.filter(item => recipe.checkpoints.includes(item.time)), recipe)
    await writeContactSheet(browser, output, 'encoded-transitions', decoded.filter(item => recipe.transitionTimes.includes(item.time)), recipe)
    const report = {
      width: recipe.width, height: recipe.height, duration: recipe.duration, frameRate: recipe.frameRate,
      scenes: recipe.scenes.length, layers: recipe.layers.length, commands: calls.reduce((sum, call) => sum + call.arguments.steps.length, 0),
      wasmSha256: hash(wasm), movieSha256: hash(movie), movieBytes: movie.length,
      checkpoints: snapshots.map(({ time, rgba }) => ({ time, sha256: hash(rgba) })),
      encoded, orientation: recipe.orientation,
      decoder: { limits, samples: decoded.map(({ time, frame, metrics }) => ({ time, frame, ...metrics })) },
      checks: ['named edit targets', 'scene timing', 'nonblank distinct shots', 'save/reopen', 'targeted revision', 'undo', 'diagnostics', 'nonmutating MP4 export', 'decoded frame count and delivery metadata', 'decoded pixel comparison', 'transition exit/cut/entrance', 'wrong-scene and blank-output negative controls'],
      audio: 'No audio in this synthetic workflow fixture',
    }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`PASS: ${report.scenes} shots, ${report.layers} editable layers; orientation: ${recipe.orientation}; artifacts: .cache/effect-promo/`)
  } finally {
    doc.free()
  }
}
