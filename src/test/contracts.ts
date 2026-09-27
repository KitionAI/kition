/**
 * Test helper: assert that a value matches a definition in a public runtime
 * contract. API specs use it so a request body or a mocked response cannot
 * drift from contracts/runtime/*.schema.json without a failing test.
 *
 *   expectMatchesContract(payload, 'email-sync', 'saveInput')
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

const contractsDir = resolve(process.cwd(), 'contracts/runtime')
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

const validators = new Map<string, ValidateFunction>()
const loaded = new Set<string>()

function loadContract(name: string) {
  if (loaded.has(name)) return
  const schema = JSON.parse(readFileSync(resolve(contractsDir, `${name}.schema.json`), 'utf8')) as Record<string, unknown>
  // Contracts reference each other by file name (for example "capabilities.schema.json").
  ajv.addSchema(schema, `${name}.schema.json`)
  loaded.add(name)
}

function validatorFor(name: string, definition?: string): ValidateFunction {
  const key = `${name}#${definition ?? ''}`
  const cached = validators.get(key)
  if (cached) return cached
  loadContract(name)
  const ref = definition ? `${name}.schema.json#/$defs/${definition}` : `${name}.schema.json`
  const validate = ajv.getSchema(ref)
  if (!validate) throw new Error(`Unknown contract reference ${ref}`)
  validators.set(key, validate)
  return validate
}

/** Throws with the Ajv error list when `value` does not satisfy the contract. */
export function expectMatchesContract(value: unknown, contract: string, definition?: string): void {
  const validate = validatorFor(contract, definition)
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? ''} ${JSON.stringify(error.params)}`)
      .join('\n  ')
    throw new Error(`Value does not match ${contract}${definition ? `#/$defs/${definition}` : ''}:\n  ${details}`)
  }
}
