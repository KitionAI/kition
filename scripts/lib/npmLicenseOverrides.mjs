// Corrections to the licence data some npm packages publish, shared by the app's notices
// (scripts/generate-third-party-notices.mjs) and the kit packages' (scripts/kit-package-notices.mjs).
//
// - `text`: the upstream licence file (scripts/licenses/packages/) of a package whose npm tarball
//   ships none; used only while the installed package still ships none.
// - `template` and `holders`: the canonical text (scripts/licenses/) of the licence the package
//   declares, with its author as the holder, when upstream has no licence file either.
// - `license`: the licence a package's licence file grants when package.json declares none.
// - `usedUnder` and `files`: the licence Kition elects for a dual-licensed package, and the files
//   that carry it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const licensesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'licenses')

const RADIX = { text: 'radix-ui-primitives.txt', source: 'https://github.com/radix-ui/primitives/blob/main/LICENSE' }

const OVERRIDES = {
  // Radix publishes some packages without the monorepo's LICENSE, which its siblings ship.
  '@radix-ui/number': RADIX,
  '@radix-ui/react-compose-refs': RADIX,
  '@radix-ui/react-context': RADIX,
  '@radix-ui/react-direction': RADIX,
  '@radix-ui/react-id': RADIX,
  '@radix-ui/react-use-callback-ref': RADIX,
  '@radix-ui/react-use-escape-keydown': RADIX,
  '@radix-ui/react-use-layout-effect': RADIX,
  '@radix-ui/react-use-previous': RADIX,
  '@radix-ui/react-use-rect': RADIX,
  '@radix-ui/react-use-size': RADIX,
  '@radix-ui/rect': RADIX,
  'react-remove-scroll-bar': { text: 'react-remove-scroll-bar.txt', source: 'https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fd/LICENSE' },
  // The licence is in the README's "License" section.
  fastdom: { text: 'fastdom.txt', source: 'README.md of fastdom 1.0.12' },
  strictdom: { text: 'strictdom.txt', source: 'README.md of strictdom 1.0.1' },
  esrecurse: { text: 'esrecurse.txt', source: 'https://github.com/estools/esrecurse/blob/master/LICENSE.md' },
  imurmurhash: { text: 'imurmurhash.txt', source: 'https://github.com/jensyt/imurmurhash-js/blob/master/LICENSE' },
  keyv: { text: 'keyv.txt', source: 'https://github.com/jaredwray/keyv/blob/e02ef9b927/LICENSE' },
  'language-tags': { text: 'language-tags.txt', source: 'https://github.com/mattcg/language-tags/blob/master/LICENSE' },
  'natural-compare': { text: 'natural-compare.txt', source: 'https://github.com/litejs/natural-compare-lite/blob/main/LICENSE' },
  saxes: { text: 'saxes.txt', source: 'https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE' },
  dlv: { template: 'MIT', holders: 'Jason Miller' },
  stackback: { template: 'MIT', holders: 'Roman Shtylman' },
  'language-subtag-registry': { template: 'CC0-1.0' },
  // package.json has no `license` field; the package's `license` file is the MIT License.
  khroma: { license: 'MIT' },
  // `(MPL-2.0 OR Apache-2.0)`: Kition uses DOMPurify under the Apache License 2.0.
  dompurify: {
    usedUnder: 'Apache-2.0',
    files: ['LICENSE'],
    note: 'Kition uses DOMPurify under the Apache License 2.0, one of its two licences; DOMPurify is (c) Cure53 and other contributors.',
  },
}

/** The override for a package, or null. */
export function npmLicenseOverride(name) {
  return OVERRIDES[name] ?? null
}

/** The licence text an override supplies for a package that ships none, or null. */
export function overrideLicenseText(override) {
  if (override?.text) return fs.readFileSync(path.join(licensesDir, 'packages', override.text), 'utf8')
  if (override?.template) {
    const text = fs.readFileSync(path.join(licensesDir, `${override.template}.txt`), 'utf8')
    return override.holders ? text.replace('<year> <copyright holders>', override.holders) : text
  }
  return null
}
