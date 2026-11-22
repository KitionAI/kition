#!/usr/bin/env node
// Checks the GitHub Actions files of this repository before they reach main. Every kit's CI and
// every runner pool read .github/workflows/kit-ci.yml and .github/actions/kit-checkout at main, so
// a file GitHub cannot load fails every kit at once (2026-11-21: an unquoted `: ` in an input's
// description made action.yml invalid YAML, and every kit's build, Rust and test jobs failed with
// "Failed to load .../kit-checkout/action.yml"). actionlint lints workflows but not composite
// action metadata, so this check covers both:
//
// - every .github/workflows/*.yml and .github/actions/**/action.yml parses as strict YAML (no
//   duplicate keys, no tab characters, no syntax errors);
// - a composite action has a name, a description and `runs.using: composite`; every step has
//   `run` or `uses`, and `shell` with `run`; every input has a string description; every
//   `inputs.X` its expressions read is a declared input;
// - a workflow's expressions read only declared inputs (workflow_call and workflow_dispatch); a
//   step that uses one of this repository's actions (`./.github/actions/<name>` or
//   `KitionAI/kition/.github/actions/<name>@<ref>`) names an existing action, passes every required
//   input and no undeclared one; a job that calls one of this repository's reusable workflows does
//   the same for its workflow_call inputs;
// - the callers of the reusable kit CI that live in other repositories, as this repository writes
//   them (each kit's ci.yml from scripts/kit-ci-install.mjs, each runner pool's <kit>.yml from
//   scripts/kit-ci-runner-repo.mjs), and any caller named with --caller, pass only declared
//   inputs of kit-ci.yml and every required one.
//
//   node scripts/check-workflows.mjs [--root <dir>] [--caller <file>]...
//
// Exits 1 and prints `<file>:<line>: <problem>` for each problem. `pnpm lint` runs it, so CI and
// the Stop hook do too.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LineCounter, parseDocument } from 'yaml'
import { KITS, ciWorkflow } from './kit-ci-install.mjs'
import { runnerRepoFiles } from './kit-ci-runner-repo.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const THIS_REPOSITORY = 'KitionAI/kition'

const ACTION_KEYS = new Set(['name', 'author', 'description', 'inputs', 'outputs', 'runs', 'branding'])
const ACTION_INPUT_KEYS = new Set(['description', 'required', 'default', 'deprecationMessage'])
const COMPOSITE_STEP_KEYS = new Set(['name', 'id', 'if', 'run', 'shell', 'uses', 'with', 'env', 'working-directory', 'continue-on-error'])
const CALL_INPUT_TYPES = new Set(['string', 'boolean', 'number'])

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** Parses YAML as strictly as GitHub loads it; returns the value and the problems, with lines. */
export function parseStrict(file, text) {
  const problems = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (line.includes('\t')) problems.push({ file, line: index + 1, message: 'tab character: indent and separate with spaces only' })
  })
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, lineCounter })
  for (const error of [...doc.errors, ...doc.warnings]) {
    const pos = Array.isArray(error.pos) ? lineCounter.linePos(error.pos[0]) : undefined
    let message = `invalid YAML (${error.code}): ${error.message.split('\n')[0]}`
    if (error.code === 'BLOCK_AS_IMPLICIT_KEY') {
      message += '. A plain (unquoted) value holds ": "; quote it or make it a folded scalar (>-)'
    }
    if (error.code === 'DUPLICATE_KEY') message += ' (a duplicated key)'
    problems.push({ file, line: pos?.line ?? 1, column: pos?.col, message })
  }
  const lineOf = (keys) => {
    for (let n = keys.length; n > 0; n -= 1) {
      const node = doc.getIn(keys.slice(0, n), true)
      if (node && node.range) return lineCounter.linePos(node.range[0]).line
    }
    return 1
  }
  return { value: problems.length ? undefined : doc.toJS(), problems, lineOf }
}

/** Every `inputs.<name>` an expression in `value` reads, with the key path where it appears. */
function inputReferences(value, keys = []) {
  const found = []
  if (typeof value === 'string') {
    const isCondition = keys[keys.length - 1] === 'if'
    const expressions = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1])
    if (isCondition && !value.includes('${{')) expressions.push(value)
    for (const expression of expressions) {
      for (const match of expression.matchAll(/(?<![\w.-])inputs\.([A-Za-z_][A-Za-z0-9_-]*)/g)) found.push({ name: match[1], keys })
      for (const match of expression.matchAll(/(?<![\w.-])inputs\[\s*'([^']+)'\s*\]/g)) found.push({ name: match[1], keys })
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...inputReferences(item, [...keys, index])))
  } else if (isMapping(value)) {
    for (const [key, item] of Object.entries(value)) found.push(...inputReferences(item, [...keys, key]))
  }
  return found
}

/** The path of this repository's action or reusable workflow that `uses` names, or null. */
function localTarget(uses, kind, { external }) {
  if (typeof uses !== 'string') return null
  const local = uses.match(new RegExp(`^\\./\\.github/${kind}/(.+?)/?$`))
  if (local && !external) return local[1]
  const remote = uses.match(new RegExp(`^${THIS_REPOSITORY}/\\.github/${kind}/([^@]+?)/?@(.+)$`, 'i'))
  if (remote) return remote[1]
  return null
}

/** Checks the `with:` of a call against the callee's declared inputs. */
function checkWith({ file, lineOf, keys, given, declared, callee, report }) {
  const passed = isMapping(given) ? given : {}
  if (given !== undefined && !isMapping(given)) report(file, lineOf(keys), `with: must be a mapping (calling ${callee})`)
  for (const name of Object.keys(passed)) {
    if (!Object.hasOwn(declared, name)) {
      report(file, lineOf([...keys, name]), `passes \`${name}\`, which ${callee} does not declare (its inputs: ${Object.keys(declared).join(', ') || 'none'})`)
    }
  }
  for (const [name, spec] of Object.entries(declared)) {
    if (isMapping(spec) && spec.required === true && spec.default === undefined && !Object.hasOwn(passed, name)) {
      report(file, lineOf(keys), `does not pass \`${name}\`, which ${callee} requires`)
    }
  }
}

/** The declared inputs of a workflow: workflow_call's and workflow_dispatch's. */
function workflowInputs(workflow, trigger) {
  const on = workflow?.on
  if (!isMapping(on)) return {}
  const triggers = trigger ? [trigger] : ['workflow_call', 'workflow_dispatch']
  const inputs = {}
  for (const name of triggers) {
    if (isMapping(on[name]) && isMapping(on[name].inputs)) Object.assign(inputs, on[name].inputs)
  }
  return inputs
}

function checkAction(file, action, lineOf, report) {
  if (!isMapping(action)) return report(file, 1, 'an action must be a mapping')
  for (const key of Object.keys(action)) {
    if (!ACTION_KEYS.has(key)) report(file, lineOf([key]), `unknown key \`${key}\` (an action has ${[...ACTION_KEYS].join(', ')})`)
  }
  if (!isNonEmptyString(action.name)) report(file, lineOf(['name']), 'an action needs `name`, a string')
  if (!isNonEmptyString(action.description)) report(file, lineOf(['description']), 'an action needs `description`, a string')
  const inputs = action.inputs ?? {}
  if (!isMapping(inputs)) report(file, lineOf(['inputs']), '`inputs` must be a mapping')
  for (const [name, spec] of Object.entries(isMapping(inputs) ? inputs : {})) {
    if (!isMapping(spec)) {
      report(file, lineOf(['inputs', name]), `input \`${name}\` must be a mapping with a description`)
      continue
    }
    for (const key of Object.keys(spec)) {
      if (!ACTION_INPUT_KEYS.has(key)) report(file, lineOf(['inputs', name, key]), `input \`${name}\` has an unknown key \`${key}\``)
    }
    if (!isNonEmptyString(spec.description)) report(file, lineOf(['inputs', name, 'description']), `input \`${name}\` needs \`description\`, a string`)
    if (spec.required !== undefined && typeof spec.required !== 'boolean') report(file, lineOf(['inputs', name, 'required']), `input \`${name}\`: \`required\` must be true or false`)
  }
  const runs = action.runs
  if (!isMapping(runs) || runs.using !== 'composite') {
    report(file, lineOf(['runs', 'using']), 'an action here is a composite action: `runs.using: composite`')
  } else if (!Array.isArray(runs.steps) || runs.steps.length === 0) {
    report(file, lineOf(['runs', 'steps']), 'a composite action needs `runs.steps`, a non-empty list')
  } else {
    runs.steps.forEach((step, index) => {
      const keys = ['runs', 'steps', index]
      if (!isMapping(step)) return report(file, lineOf(keys), `step ${index + 1} must be a mapping`)
      const label = `step ${index + 1}${step.name ? ` (${step.name})` : ''}`
      for (const key of Object.keys(step)) {
        if (!COMPOSITE_STEP_KEYS.has(key)) report(file, lineOf([...keys, key]), `${label}: a composite step cannot have \`${key}\``)
      }
      if ((step.run === undefined) === (step.uses === undefined)) report(file, lineOf(keys), `${label} needs exactly one of \`run\` and \`uses\``)
      if (step.run !== undefined && !isNonEmptyString(step.shell)) report(file, lineOf(keys), `${label} has \`run\` but no \`shell\` (a composite action's run steps need one)`)
      if (typeof step.uses === 'string' && !step.uses.startsWith('./') && !step.uses.startsWith('docker://') && !step.uses.includes('@')) {
        report(file, lineOf([...keys, 'uses']), `${label}: \`uses: ${step.uses}\` needs a ref (@<ref>)`)
      }
    })
  }
  const declared = isMapping(inputs) ? inputs : {}
  for (const reference of inputReferences(action)) {
    if (!Object.hasOwn(declared, reference.name)) report(file, lineOf(reference.keys), `reads \`inputs.${reference.name}\`, which the action does not declare`)
  }
}

function checkWorkflow(file, workflow, lineOf, report, context, { external = false } = {}) {
  if (!isMapping(workflow)) return report(file, 1, 'a workflow must be a mapping')
  if (workflow.on === undefined) report(file, 1, 'a workflow needs `on`')
  if (!isMapping(workflow.jobs) || Object.keys(workflow.jobs).length === 0) return report(file, lineOf(['jobs']), 'a workflow needs `jobs`, a non-empty mapping')
  const call = isMapping(workflow.on) ? workflow.on.workflow_call : undefined
  if (isMapping(call) && isMapping(call.inputs)) {
    for (const [name, spec] of Object.entries(call.inputs)) {
      const keys = ['on', 'workflow_call', 'inputs', name]
      if (!isMapping(spec)) {
        report(file, lineOf(keys), `workflow_call input \`${name}\` must be a mapping`)
        continue
      }
      if (!CALL_INPUT_TYPES.has(spec.type)) report(file, lineOf([...keys, 'type']), `workflow_call input \`${name}\` needs \`type\`: string, boolean or number`)
      if (spec.description !== undefined && typeof spec.description !== 'string') report(file, lineOf([...keys, 'description']), `workflow_call input \`${name}\`: \`description\` must be a string`)
      if (spec.required !== undefined && typeof spec.required !== 'boolean') report(file, lineOf([...keys, 'required']), `workflow_call input \`${name}\`: \`required\` must be true or false`)
    }
  }
  const declared = workflowInputs(workflow)
  for (const reference of inputReferences(workflow.jobs, ['jobs']).concat(inputReferences(workflow['run-name'], ['run-name']), inputReferences(workflow.env, ['env']))) {
    if (!Object.hasOwn(declared, reference.name)) report(file, lineOf(reference.keys), `reads \`inputs.${reference.name}\`, which the workflow does not declare`)
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const jobKeys = ['jobs', jobName]
    if (!isMapping(job)) {
      report(file, lineOf(jobKeys), `job \`${jobName}\` must be a mapping`)
      continue
    }
    if (job.uses !== undefined) {
      const target = localTarget(job.uses, 'workflows', { external })
      if (target !== null) {
        const callee = context.workflows.get(target)
        if (!context.workflows.has(target)) {
          report(file, lineOf([...jobKeys, 'uses']), `job \`${jobName}\` calls .github/workflows/${target}, which does not exist`)
        } else if (callee === undefined) {
          report(file, lineOf([...jobKeys, 'uses']), `job \`${jobName}\` calls .github/workflows/${target}, which is not valid YAML, so GitHub cannot load it`)
        } else if (!isMapping(callee.on) || callee.on.workflow_call === undefined) {
          report(file, lineOf([...jobKeys, 'uses']), `job \`${jobName}\` calls .github/workflows/${target}, which has no \`on: workflow_call\``)
        } else {
          checkWith({ file, lineOf, keys: [...jobKeys, 'with'], given: job.with, declared: workflowInputs(callee, 'workflow_call'), callee: `.github/workflows/${target}`, report })
        }
      }
      continue
    }
    if (!Array.isArray(job.steps)) {
      report(file, lineOf(jobKeys), `job \`${jobName}\` needs \`steps\` or \`uses\``)
      continue
    }
    job.steps.forEach((step, index) => {
      const keys = [...jobKeys, 'steps', index]
      if (!isMapping(step)) return report(file, lineOf(keys), `job \`${jobName}\` step ${index + 1} must be a mapping`)
      const label = `job \`${jobName}\` step ${index + 1}${step.name ? ` (${step.name})` : ''}`
      if ((step.run === undefined) === (step.uses === undefined)) report(file, lineOf(keys), `${label} needs exactly one of \`run\` and \`uses\``)
      if (typeof step.uses === 'string' && !step.uses.startsWith('./') && !step.uses.startsWith('docker://') && !step.uses.includes('@')) {
        report(file, lineOf([...keys, 'uses']), `${label}: \`uses: ${step.uses}\` needs a ref (@<ref>)`)
      }
      const target = localTarget(step.uses, 'actions', { external })
      if (target === null) return
      const action = context.actions.get(target)
      if (!context.actions.has(target)) return report(file, lineOf([...keys, 'uses']), `${label} uses .github/actions/${target}, which does not exist`)
      if (action === undefined) return report(file, lineOf([...keys, 'uses']), `${label} uses .github/actions/${target}, which is not valid YAML, so GitHub cannot load it`)
      checkWith({ file, lineOf, keys: [...keys, 'with'], given: step.with, declared: isMapping(action.inputs) ? action.inputs : {}, callee: `.github/actions/${target}`, report })
    })
  }
}

/**
 * Checks in-memory files. `files`: repository-relative path → text (the .github/ files);
 * `callers`: a name → the text of a workflow in another repository that calls this one's.
 * Returns the problems, `{ file, line, message }`, sorted by file and line.
 */
export function checkFiles({ files, callers = {} }) {
  const problems = []
  const report = (file, line, message) => problems.push({ file, line, message })
  const actions = new Map()
  const workflows = new Map()
  const parsed = []
  for (const [file, text] of Object.entries(files)) {
    const workflow = file.match(/^\.github\/workflows\/([^/]+\.ya?ml)$/)
    const action = file.match(/^\.github\/actions\/(.+)\/action\.ya?ml$/)
    if (!workflow && !action) continue
    const result = parseStrict(file, text)
    problems.push(...result.problems)
    if (action) {
      if (actions.has(action[1])) report(file, 1, `.github/actions/${action[1]} has both action.yml and action.yaml`)
      actions.set(action[1], result.value)
    } else {
      workflows.set(workflow[1], result.value)
    }
    if (result.value !== undefined) parsed.push({ file, kind: action ? 'action' : 'workflow', ...result })
  }
  const context = { actions, workflows }
  for (const { file, kind, value, lineOf } of parsed) {
    if (kind === 'action') checkAction(file, value, lineOf, report)
    else checkWorkflow(file, value, lineOf, report, context)
  }
  for (const [name, text] of Object.entries(callers)) {
    const result = parseStrict(name, text)
    problems.push(...result.problems)
    if (result.value === undefined) continue
    const calls = Object.values(isMapping(result.value.jobs) ? result.value.jobs : {}).filter((job) => isMapping(job) && localTarget(job.uses, 'workflows', { external: true }) !== null)
    if (calls.length === 0) report(name, 1, `calls no reusable workflow of ${THIS_REPOSITORY}, so there is nothing to check`)
    checkWorkflow(name, result.value, result.lineOf, report, context, { external: true })
  }
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/** The callers of kit-ci.yml that this repository writes for other repositories. */
export function generatedCallers() {
  const callers = {}
  for (const kit of KITS) callers[`scripts/kit-ci-install.mjs (kition-${kit} .github/workflows/ci.yml)`] = ciWorkflow(kit)
  for (const [file, text] of Object.entries(runnerRepoFiles(''))) {
    if (file.startsWith('.github/workflows/')) callers[`scripts/kit-ci-runner-repo.mjs (${file})`] = text
  }
  return callers
}

/** Reads the .github/ workflows and actions under `root`: repository-relative path → text. */
export function readGithubFiles(root) {
  const files = {}
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(path.join(root, '.github', 'workflows'))
  walk(path.join(root, '.github', 'actions'))
  return files
}

export function formatProblem({ file, line, message }) {
  return `${file}:${line}: ${message}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let root = path.resolve(here, '..')
  const callers = generatedCallers()
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i])
    else if (args[i] === '--caller' && args[i + 1]) {
      const file = args[++i]
      callers[file] = fs.readFileSync(file, 'utf8')
    } else {
      console.error('usage: node scripts/check-workflows.mjs [--root <dir>] [--caller <file>]...')
      process.exit(2)
    }
  }
  const files = readGithubFiles(root)
  const problems = checkFiles({ files, callers })
  const count = (pattern) => Object.keys(files).filter((file) => pattern.test(file)).length
  if (problems.length) {
    for (const problem of problems) console.error(formatProblem(problem))
    console.error(`check-workflows: ${problems.length} problem(s). Every kit and runner pool reads these files from main; fix them before pushing.`)
    process.exit(1)
  }
  console.log(`check-workflows: ${count(/^\.github\/workflows\/[^/]+\.ya?ml$/)} workflows, ${count(/^\.github\/actions\/.+\/action\.ya?ml$/)} actions and ${Object.keys(callers).length} callers: no problems`)
}
