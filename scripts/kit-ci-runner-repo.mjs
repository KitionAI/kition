#!/usr/bin/env node
// Writes a runner-pool repository for the kit CI: one public repository in another GitHub
// organization whose workflows run Kition's reusable kit CI (.github/workflows/kit-ci.yml) for a
// given commit of a public kit repository. A run counts against the concurrent jobs of the
// organization that owns the repository it runs in, so each pool adds that organization's 20.
//
//   node scripts/kit-ci-runner-repo.mjs <out-dir>
//
// It writes .github/workflows/<kit>.yml for each of the 16 kits, a README and the LICENSE
// (Kition's, Apache-2.0). The output depends on nothing but this script and Kition's LICENSE.
// scripts/kit-ci.sh dispatches `<kit>.yml` with `-f sha=<commit>` and finds the run by its name,
// `<kit> <sha>`; scripts/kit-ci-pools.json lists the pools. How to add one: docs/kits.md, 4c.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KITS } from './kit-ci-install.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The workflow that tests one commit of KitionAI/kition-<kit> in a runner pool. */
export function runnerWorkflow(kit) {
  if (!KITS.includes(kit)) throw new Error(`unknown kit ${kit}; the kits are ${KITS.join(', ')}`)
  return `name: ${kit}

# Runs Kition's kit CI (KitionAI/kition .github/workflows/kit-ci.yml at main) for one commit of
# the public repository KitionAI/kition-${kit}. Written by Kition's scripts/kit-ci-runner-repo.mjs;
# started by Kition's scripts/kit-ci.sh (gh workflow run ${kit}.yml -f sha=<commit>), which finds
# the run by its name. A newer dispatch for ${kit} cancels the older one.

on:
  workflow_dispatch:
    inputs:
      sha:
        description: The commit of KitionAI/kition-${kit} to test (the full 40-character SHA)
        required: true
        type: string
      ref_note:
        description: A note for humans (where the commit comes from); the run does not read it
        required: false
        type: string
        default: ''

run-name: ${kit} \${{ inputs.sha }}

permissions:
  contents: read

concurrency:
  group: ${kit}
  cancel-in-progress: true

jobs:
  ci:
    uses: KitionAI/kition/.github/workflows/kit-ci.yml@main
    with:
      kit: ${kit}
      repository: KitionAI/kition-${kit}
      ref: \${{ inputs.sha }}
`
}

export function runnerReadme() {
  const rows = KITS.map((kit) => `| ${kit} | [KitionAI/kition-${kit}](https://github.com/KitionAI/kition-${kit}) | \`.github/workflows/${kit}.yml\` |`)
  return `# Kition kit CI runners

CI runners for the public Kition kits. No source lives here: each workflow in
\`.github/workflows/\` checks out one commit of a public kit repository and runs Kition's
reusable kit CI on it
([\`KitionAI/kition\` .github/workflows/kit-ci.yml](https://github.com/KitionAI/kition/blob/main/.github/workflows/kit-ci.yml),
always at \`main\`). The runs use this organization's GitHub Actions runners, which adds to the
concurrent jobs of the KitionAI organization.

The kits' code, issues and pull requests live in their own repositories:

| Kit | Repository | Workflow |
| --- | --- | --- |
${rows.join('\n')}

A run is started by Kition's \`scripts/kit-ci.sh\` (\`gh workflow run <kit>.yml -f sha=<commit>\`)
and is named \`<kit> <commit>\`; the plan job's artifact \`tested\` (\`tested.json\`) names the
repository and the commit that were tested. Do not edit these files by hand: they are written by
\`node scripts/kit-ci-runner-repo.mjs <dir>\` in [KitionAI/kition](https://github.com/KitionAI/kition),
whose \`docs/kits.md\` (section 4c, Kit CI) explains runner pools.

## License

Apache-2.0, as Kition: see [LICENSE](LICENSE).
`
}

/** Every file of the runner repository: relative path → content. */
export function runnerRepoFiles(license = fs.readFileSync(path.join(here, '..', 'LICENSE'), 'utf8')) {
  const files = { 'README.md': runnerReadme(), LICENSE: license }
  for (const kit of KITS) files[`.github/workflows/${kit}.yml`] = runnerWorkflow(kit)
  return files
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out || process.argv.length > 3) {
    console.error('usage: node scripts/kit-ci-runner-repo.mjs <out-dir>')
    process.exit(2)
  }
  for (const [file, content] of Object.entries(runnerRepoFiles())) {
    const target = path.join(out, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  console.log(`wrote the runner repository for ${KITS.length} kits to ${out}`)
}
