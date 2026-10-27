import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { cases } from './cases.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../..')
const baseline = JSON.parse(await fs.readFile(process.argv[2] || path.join(directory, 'baseline.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(baseline.schema, 1, 'Unsupported baseline schema')
assert.equal(baseline.casesSha256, hash(JSON.stringify(cases)), 'Cases changed: capture and review a new reference candidate')
assert.equal(baseline.adapterSha256, hash(await fs.readFile(path.join(directory, 'reference.rs'))), 'Capture adapter changed: review baseline provenance')
assert.deepEqual(baseline.results.map(result => result.id), cases.map(item => item.id), 'Missing, reordered, or duplicate baseline cases')
const packageDirectory = path.join(root, 'public/kits/effect-ui')
const packageInfo = JSON.parse(await fs.readFile(path.join(packageDirectory, 'kit-ui.json'), 'utf8'))
const wasm = await fs.readFile(path.join(packageDirectory, 'engine/kition_effect_sdk_bg.wasm'))
const sdk = await import(pathToFileURL(path.join(packageDirectory, 'engine/kition_effect_sdk.js')).href)
await sdk.default({ module_or_path: wasm })
const report = { schema: 1, reference: baseline.reference, package: packageInfo, wasmSha256: hash(wasm), cases: [] }
const output = path.join(root, 'test-results/effect-regression')
await fs.mkdir(output, { recursive: true })

// Runtime object identifiers are not a fidelity requirement; preserve relationships and stack order.
function normalizeInfo(info) {
  const names = new Map(info.layers.map(layer => [layer.id, layer.name]))
  const { id: _id, ...rest } = info
  return {
    ...rest,
    layers: info.layers.map(({ id: _layerId, parent, trackMatte, ...layer }) => ({
      ...layer, parent: parent === null ? null : names.get(parent) ?? parent,
      trackMatte: trackMatte === null ? null : { ...trackMatte, layer: names.get(trackMatte.layer) ?? trackMatte.layer },
    })),
  }
}

function compareValues(actual, expected, location) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', location)
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9, `${location}: ${actual} != ${expected}`)
  } else if (expected !== null && typeof expected === 'object') {
    assert.equal(Array.isArray(actual), Array.isArray(expected), location)
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${location}: fields`)
    for (const key of Object.keys(expected)) compareValues(actual[key], expected[key], `${location}.${key}`)
  } else assert.equal(actual, expected, location)
}

let checkpoints = 0
for (const [index, scenario] of cases.entries()) {
  let doc = sdk.EffectDocument.create('Regression.keffect', scenario.width, scenario.height)
  const result = { id: scenario.id, passed: false, checkpoints: 0, frames: [] }
  try {
    const execute = (command, params = {}) => JSON.parse(doc.execute(command, JSON.stringify(params)))
    let checkpointIndex = 0
    for (const step of scenario.steps) {
      if (step.command) {
        if (step.error) {
          const before = Buffer.from(doc.save())
          assert.throws(() => execute(step.command, step.params), undefined, `${step.command} must reject invalid input`)
          assert.deepEqual(Buffer.from(doc.save()), before, `${step.command} changed the project on failure`)
        } else execute(step.command, step.params)
        continue
      }
      const expected = baseline.results[index].snapshots[checkpointIndex++]
      assert.equal(expected?.label, step.checkpoint, 'Checkpoint missing or out of order')
      const location = `${scenario.id}/${step.checkpoint}`
      const verify = phase => {
        execute('time.set', { time: step.time })
        compareValues(normalizeInfo(execute('comp.info')), normalizeInfo(expected.info), `${location}/composition`)
        const properties = step.queries.map(({ fields = ['value', 'animated'], expected: asserted, ...query }) => {
          const value = execute('prop.get', { ...query, time: step.time, timeBase: 'comp' })
          const projected = Object.fromEntries(fields.map(field => [field, field === 'expressionError' ? Boolean(value[field]) : value[field] ?? null]))
          // Mathematical expectations additionally detect an inert or silently disabled expression.
          for (const [field, expected] of Object.entries(asserted ?? {})) compareValues(projected[field], expected, `${location}/asserted/${field}`)
          return projected
        })
        compareValues(properties, expected.properties, `${location}/properties`)
        assert.equal(doc.width, expected.width, `${location}/width`)
        assert.equal(doc.height, expected.height, `${location}/height`)
        const reference = gunzipSync(Buffer.from(expected.rgbaGzip, 'base64'))
        assert.equal(hash(reference), expected.rgbaSha256, `${location}/reference integrity`)
        const actual = Buffer.from(doc.render(0, 0, 1, expected.width, expected.height))
        assert.equal(reference.length, expected.width * expected.height * 4, `${location}/reference size`)
        assert.equal(actual.length, reference.length, `${location}/frame size`)
        let maxDelta = 0
        let differingChannels = 0
        for (let channel = 0; channel < actual.length; channel++) {
          const delta = Math.abs(actual[channel] - reference[channel])
          maxDelta = Math.max(maxDelta, delta)
          if (delta) differingChannels++
        }
        result.frames.push({ checkpoint: step.checkpoint, phase, maxDelta, differingChannels, actualSha256: hash(actual) })
        if (maxDelta > 1) {
          const prefix = `${scenario.id}-${checkpointIndex}-${phase}`
          writeFileSync(path.join(output, `${prefix}-actual.rgba`), actual)
          writeFileSync(path.join(output, `${prefix}-reference.rgba`), reference)
          result.pixelFailure = { prefix, width: expected.width, height: expected.height, format: 'RGBA8' }
        }
        // One 8-bit unit accommodates native/WASM rounding; no percentage of bad pixels is allowed.
        assert.ok(maxDelta <= 1, `${location}/pixels: max delta ${maxDelta}, ${differingChannels} differing channels`)
      }
      verify('live')
      // Persisted projects must reproduce the same reference, without losing the live undo stack.
      const reopened = sdk.EffectDocument.open('Regression.keffect', doc.save())
      const live = doc
      doc = reopened
      try { verify('reopened') } finally { doc.free(); doc = live }
      result.checkpoints++
      checkpoints++
    }
    assert.equal(checkpointIndex, baseline.results[index].snapshots.length, 'Unconsumed reference checkpoints')
    result.passed = true
    console.log(`PASS ${scenario.id} (${result.checkpoints} checkpoints, including save/reopen)`)
  } catch (error) {
    result.error = String(error)
    console.error(`FAIL ${scenario.id}: ${error}`)
  } finally {
    doc.free()
    report.cases.push(result)
  }
}
await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const failures = report.cases.filter(result => !result.passed)
console.log(`${cases.length - failures.length}/${cases.length} cases passed; ${checkpoints} checkpoints; report: test-results/effect-regression/report.json`)
if (failures.length) process.exitCode = 1
