#!/usr/bin/env node
// Checks a built kit engine (public/kits/<kit>-ui/engine, in the kit's package) against the Kit SDK contract in
// docs/kit-sdk.md, through its JavaScript interface, the way Kition uses it.
//
//   node scripts/check-kit-sdk.mjs --kit photo            one kit from kits/sdks.json
//   node scripts/check-kit-sdk.mjs --all                  every kit in kits/sdks.json that is built
//   node scripts/check-kit-sdk.mjs --dir <sdk dir> --module <module> --class <Class> \
//     --name <file name> --edit '{"command":…,"params":…}' (or a list of steps)      any SDK, for example a third-party one
//
// --fixture <file> opens a real file; without it the SDK's own create() and save() make one.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const SUPPORTED_CONTRACT = 1

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'sdks.json'), 'utf8'))

if (process.argv.includes('--all')) {
  let failures = 0
  for (const kit of Object.keys(registry).filter((key) => !key.startsWith('$'))) {
    const built = fs.existsSync(path.join(repoRoot, 'public', 'kits', `${kit}-ui`, 'engine', `${registry[kit].module}_bg.wasm`))
    if (!built) {
      console.log(`SKIP ${kit}: not built (make kit-ui-${kit})`)
      continue
    }
    console.log(`== ${kit}`)
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--kit', kit], { stdio: 'inherit' })
    if (run.status !== 0) failures += 1
  }
  process.exit(failures ? 1 : 0)
}

const kit = argument('kit')
const entry = kit ? registry[kit] : null
if (kit && !entry) {
  console.error(`kits/sdks.json has no kit "${kit}"`)
  process.exit(2)
}
const dir = path.resolve(argument('dir', entry ? path.join(repoRoot, 'public', 'kits', `${kit}-ui`, 'engine') : ''))
const moduleName = argument('module', entry?.module ?? '')
const className = argument('class', entry?.class ?? '')
const name = argument('name', entry?.name ?? 'fixture')
const fixturePath = argument('fixture')
const edit = argument('edit') ? JSON.parse(argument('edit')) : entry?.edit ?? null
if (!dir || !moduleName || !className || !(Array.isArray(edit) ? edit.length : edit?.command)) {
  console.error('usage: check-kit-sdk.mjs --kit <kit> | --all | --dir <sdk dir> --module <module> --class <Class> --name <file name> --edit <{"command","params"}> [--fixture <file>]')
  process.exit(2)
}

const results = []
function check(label, run) {
  try {
    const detail = run()
    results.push({ ok: true, label, detail })
  } catch (error) {
    results.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sdk = await import(pathToFileURL(path.join(dir, `${moduleName}.js`)).href)
await sdk.default({ module_or_path: fs.readFileSync(path.join(dir, `${moduleName}_bg.wasm`)) })
const Document = sdk[className]
assert(Document, `${moduleName}.js exports no ${className}`)

check('contract version is supported', () => {
  const version = typeof Document.contractVersion === 'function' ? Document.contractVersion() : 1
  assert(version <= SUPPORTED_CONTRACT, `the SDK needs contract ${version}; this checker knows ${SUPPORTED_CONTRACT}`)
  return `contract ${version}`
})
check('bad bytes are an error, not a crash', () => {
  let failed = false
  try {
    Document.open(name, new Uint8Array([1, 2, 3])).free()
  } catch {
    failed = true
  }
  assert(failed, 'open accepted three random bytes')
})

let fixture
if (fixturePath) fixture = new Uint8Array(fs.readFileSync(fixturePath))
else {
  const made = Document.create(name, 64, 40)
  fixture = made.save()
  made.free()
}
const doc = Document.open(name, fixture)
const { width, height } = doc
let full

check('opens with a size', () => {
  assert(width > 0 && height > 0, `size ${width} x ${height}`)
  return `${width} x ${height}`
})
check('render returns width x height x 4 bytes', () => {
  full = doc.render(0, 0, 1, width, height)
  assert(full.length === width * height * 4, `${full.length} bytes`)
})
check('renderArea at 1/2 is the box mean', () => {
  const ow = Math.min(16, Math.floor(width / 2))
  const oh = Math.min(16, Math.floor(height / 2))
  const reduced = doc.renderArea(0, 0, ow * 2, oh * 2, ow, oh)
  assert(reduced.length === ow * oh * 4, `${reduced.length} bytes`)
  for (let y = 0; y < oh; y += 1) {
    for (let x = 0; x < ow; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        const at = (px, py) => full[(py * width + px) * 4 + c]
        const mean = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4
        const got = reduced[(y * ow + x) * 4 + c]
        assert(Math.abs(got - mean) <= 2.5, `(${x}, ${y}) channel ${c}: ${got} vs ${mean}`)
      }
    }
  }
})
check('inspect is JSON with canUndo and canRedo', () => {
  const inspected = JSON.parse(doc.inspect())
  assert(typeof inspected.canUndo === 'boolean' && typeof inspected.canRedo === 'boolean', 'missing canUndo or canRedo')
})
check('disabledCommands agrees with commands', () => {
  if (typeof doc.disabledCommands !== 'function') return 'not exported (contract 1 before disabledCommands); hosts fall back to commands()'
  const disabled = JSON.parse(doc.disabledCommands())
  assert(Array.isArray(disabled) && disabled.every((id) => typeof id === 'string'), 'disabledCommands must be a JSON array of ids')
  const expected = JSON.parse(doc.commands()).filter((command) => !command.enabled).map((command) => command.id).sort()
  const got = [...disabled].sort()
  assert(JSON.stringify(got) === JSON.stringify(expected), `disabled ${got.length} commands, commands() says ${expected.length}`)
  return `${got.length} disabled; ${doc.disabledCommands().length} bytes instead of ${doc.commands().length}`
})

check('commands are well formed and include undo and redo', () => {
  const commands = JSON.parse(doc.commands())
  assert(Array.isArray(commands) && commands.length, 'no commands')
  for (const command of commands) {
    assert(typeof command.id === 'string' && typeof command.title === 'string', `bad command ${JSON.stringify(command).slice(0, 80)}`)
    assert(typeof command.enabled === 'boolean' && typeof command.mutates === 'boolean', `${command.id}: enabled and mutates must be booleans`)
    assert(command.menu == null || Array.isArray(command.menu), `${command.id}: menu must be an array or null`)
  }
  for (const id of ['edit.undo', 'edit.redo']) assert(commands.some((command) => command.id === id), `no ${id}`)
  // Agent schemas (standard E7, A5): a ParameterSchemaSpec of typed properties.
  const kinds = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])
  const checkNode = (node, at, property) => {
    assert(node && typeof node === 'object' && !Array.isArray(node), `${at}: a schema node is an object`)
    if (property && 'required' in node) assert(node.required === true, `${at}: required must be true`)
    if (node.oneOf) {
      assert(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${at}: oneOf needs two branches`)
      node.oneOf.forEach((branch, index) => checkNode(branch, `${at}.oneOf[${index}]`, false))
      return
    }
    assert(kinds.has(node.type), `${at}: unknown type ${node.type}`)
    if (node.type === 'object') assert(typeof node.additionalProperties === 'boolean', `${at}: objects state additionalProperties`)
    if (node.items) checkNode(node.items, `${at}[]`, false)
    for (const [key, inner] of Object.entries(node.properties ?? {})) checkNode(inner, `${at}.${key}`, true)
  }
  let schemas = 0
  for (const command of commands) {
    if (command.schema == null) continue
    schemas += 1
    assert(typeof command.schema === 'object' && !Array.isArray(command.schema), `${command.id}: the schema is an object of parameters`)
    for (const [key, node] of Object.entries(command.schema)) checkNode(node, `${command.id}.${key}`, true)
  }
  return `${commands.length} commands, ${schemas} with agent schemas`
})
check('unknown commands are errors', () => {
  let failed = false
  try {
    doc.execute('kition.no-such-command', '{}')
  } catch {
    failed = true
  }
  assert(failed, 'an unknown command did not fail')
})
let edited
check('the edit moves revision, sets dirty, and changes pixels', () => {
  const before = doc.revision
  // One step or several; a string "$<n>.<field>" in params is step n's result field.
  const steps = Array.isArray(edit) ? edit : [edit]
  const results = []
  for (const step of steps) {
    const params = JSON.parse(JSON.stringify(step.params ?? {}), (_, value) => {
      const match = typeof value === 'string' && /^\$(\d+)\.(\w+)$/.exec(value)
      return match ? results[Number(match[1])]?.[match[2]] : value
    })
    results.push(JSON.parse(doc.execute(step.command, JSON.stringify(params))))
  }
  assert(doc.revision !== before, 'revision did not move')
  assert(doc.dirty, 'not dirty after the edit')
  edited = doc.render(0, 0, 1, doc.width, doc.height)
  assert(edited.some((value, index) => value !== full[index]), 'the render did not change')
})
check('save leaves the document dirty until markSaved, and reopens the same', () => {
  const bytes = doc.save()
  assert(doc.dirty, 'save marked the document saved; only markSaved may')
  doc.markSaved()
  assert(!doc.dirty, 'markSaved left the document dirty')
  const reopened = Document.open(name, bytes)
  const pixels = reopened.render(0, 0, 1, reopened.width, reopened.height)
  reopened.free()
  assert(pixels.length === edited.length && pixels.every((value, index) => value === edited[index]), 'the saved bytes reopened to different pixels')
})
doc.free()

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.label}${result.detail ? ` - ${result.detail}` : ''}`)
const failed = results.filter((result) => !result.ok).length
console.log(`${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
