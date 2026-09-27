#!/usr/bin/env node
/**
 * Generate TypeScript types from the public runtime contracts.
 *
 *   node scripts/generate-contract-types.mjs          # write src/api/generated/*.ts
 *   node scripts/generate-contract-types.mjs --check  # fail if committed output is stale
 *
 * One module per contracts/runtime/<name>.schema.json. Every `$defs` entry
 * becomes an exported type named <PascalName><PascalKey>, so
 * email-sync.schema.json#/$defs/workflow is `EmailSyncWorkflow`, and the root
 * schema becomes `<PascalName>Contract`. Hand-written API modules alias these
 * names instead of redeclaring shapes, which keeps the client and the private
 * runtime on the same contract by construction.
 *
 * This is a deliberately small JSON Schema subset: type, properties, required,
 * additionalProperties, items, enum, const, $ref (local and sibling file),
 * oneOf, anyOf, allOf, and nullable type arrays. Validation-only keywords
 * (minimum, pattern, if/then, ...) do not affect the emitted types.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractsDir = resolve(repositoryDir, 'contracts/runtime')
const outputDir = resolve(repositoryDir, 'src/api/generated')
const check = process.argv.includes('--check')

function pascal(value) {
  return String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function propertyKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

function literal(value) {
  return JSON.stringify(value)
}

function docComment(schema, indent) {
  const lines = []
  if (schema.description) lines.push(...String(schema.description).split('\n'))
  if (schema.default !== undefined) lines.push(`@default ${JSON.stringify(schema.default)}`)
  if (lines.length === 0) return ''
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join('\n')}\n${indent} */\n`
}

class Generator {
  constructor(stem, schema) {
    this.stem = stem
    this.prefix = pascal(stem)
    this.schema = schema
    this.defs = schema.$defs ?? schema.definitions ?? {}
    this.imports = new Map()
  }

  refType(ref) {
    const local = ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)
    if (local) {
      if (!(local[1] in this.defs)) throw new Error(`${this.stem}: unknown local ref ${ref}`)
      return `${this.prefix}${pascal(local[1])}`
    }
    const sibling = ref.match(/^([a-z0-9-]+)\.schema\.json(?:#\/(?:\$defs|definitions)\/([^/]+))?$/)
    if (sibling) {
      const otherStem = sibling[1]
      const name = sibling[2] ? `${pascal(otherStem)}${pascal(sibling[2])}` : `${pascal(otherStem)}Contract`
      if (!this.imports.has(otherStem)) this.imports.set(otherStem, new Set())
      this.imports.get(otherStem).add(name)
      return name
    }
    throw new Error(`${this.stem}: unsupported $ref ${ref}`)
  }

  objectType(schema, indent) {
    const properties = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const inner = `${indent}  `
    const members = []
    for (const [name, property] of Object.entries(properties)) {
      const optional = required.has(name) ? '' : '?'
      members.push(`${docComment(property, inner)}${inner}${propertyKey(name)}${optional}: ${this.typeOf(property, inner)}`)
    }
    const additional = schema.additionalProperties
    if (additional === undefined || additional === true) {
      if (members.length === 0) return 'Record<string, unknown>'
    } else if (additional && typeof additional === 'object') {
      members.push(`${inner}[key: string]: ${this.typeOf(additional, inner)}`)
    }
    if (schema.patternProperties && members.length === 0) {
      const union = Object.values(schema.patternProperties).map((value) => this.typeOf(value, inner))
      return `Record<string, ${[...new Set(union)].join(' | ') || 'unknown'}>`
    }
    if (members.length === 0) return 'Record<string, never>'
    return `{\n${members.join('\n')}\n${indent}}`
  }

  typeOf(schema, indent = '') {
    if (schema === true || schema === undefined) return 'unknown'
    if (schema === false) return 'never'
    if (schema.$ref) return this.refType(schema.$ref)
    if (schema.const !== undefined) return literal(schema.const)
    if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ')
    if (Array.isArray(schema.oneOf)) return this.union(schema.oneOf, indent)
    if (Array.isArray(schema.anyOf)) return this.union(schema.anyOf, indent)
    if (Array.isArray(schema.allOf)) {
      return schema.allOf.map((entry) => `(${this.typeOf(entry, indent)})`).join(' & ')
    }
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
    if (types.length === 0) {
      if (schema.properties || schema.additionalProperties !== undefined) return this.objectType(schema, indent)
      if (schema.items) return this.arrayType(schema, indent)
      return 'unknown'
    }
    const parts = types.map((type) => {
      switch (type) {
        case 'string':
          return 'string'
        case 'number':
        case 'integer':
          return 'number'
        case 'boolean':
          return 'boolean'
        case 'null':
          return 'null'
        case 'array':
          return this.arrayType(schema, indent)
        case 'object':
          return this.objectType(schema, indent)
        default:
          throw new Error(`${this.stem}: unsupported type ${type}`)
      }
    })
    return [...new Set(parts)].join(' | ')
  }

  union(entries, indent) {
    const parts = entries.map((entry) => this.typeOf(entry, indent))
    return [...new Set(parts)].join(' | ')
  }

  arrayType(schema, indent) {
    if (Array.isArray(schema.items)) {
      return `[${schema.items.map((item) => this.typeOf(item, indent)).join(', ')}]`
    }
    const item = this.typeOf(schema.items ?? true, indent)
    return /[ |&]/.test(item) ? `Array<${item}>` : `${item}[]`
  }

  render(sourceFile) {
    const body = []
    for (const [key, def] of Object.entries(this.defs)) {
      body.push(`${docComment(def, '')}export type ${this.prefix}${pascal(key)} = ${this.typeOf(def)}\n`)
    }
    const root = { ...this.schema }
    delete root.$defs
    delete root.definitions
    body.push(`${docComment(root, '')}export type ${this.prefix}Contract = ${this.typeOf(root)}\n`)
    const imports = [...this.imports.entries()]
      .sort()
      .map(([stem, names]) => `import type { ${[...names].sort().join(', ')} } from './${stem}'`)
    const header = `/* eslint-disable */\n/**\n * GENERATED FILE. Do not edit.\n * Source: contracts/runtime/${sourceFile}\n * Regenerate with: pnpm run contracts:generate\n */\n`
    return `${header}${imports.length ? `\n${imports.join('\n')}\n` : ''}\n${body.join('\n')}`
  }
}

function generate() {
  const files = readdirSync(contractsDir).filter((name) => name.endsWith('.schema.json')).sort()
  const outputs = new Map()
  for (const file of files) {
    const stem = basename(file, '.schema.json')
    const schema = JSON.parse(readFileSync(resolve(contractsDir, file), 'utf8'))
    outputs.set(`${stem}.ts`, new Generator(stem, schema).render(file))
  }
  const index = `/* eslint-disable */\n/**\n * GENERATED FILE. Do not edit.\n * Source: contracts/runtime/*.schema.json\n * Regenerate with: pnpm run contracts:generate\n */\n\n${files
    .map((file) => `export * from './${basename(file, '.schema.json')}'`)
    .join('\n')}\n`
  outputs.set('index.ts', index)
  return outputs
}

const outputs = generate()

if (check) {
  const stale = []
  for (const [name, content] of outputs) {
    const target = resolve(outputDir, name)
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) stale.push(name)
  }
  const extra = existsSync(outputDir)
    ? readdirSync(outputDir).filter((name) => name.endsWith('.ts') && !outputs.has(name))
    : []
  if (stale.length > 0 || extra.length > 0) {
    if (stale.length > 0) console.error(`[contracts] stale generated files: ${stale.join(', ')}`)
    if (extra.length > 0) console.error(`[contracts] generated files without a contract: ${extra.join(', ')}`)
    console.error('Run: pnpm run contracts:generate')
    process.exit(1)
  }
  console.log(`[contracts] OK: ${outputs.size} generated files are current.`)
} else {
  mkdirSync(outputDir, { recursive: true })
  for (const [name, content] of outputs) writeFileSync(resolve(outputDir, name), content)
  console.log(`[contracts] wrote ${outputs.size} files to src/api/generated`)
}
