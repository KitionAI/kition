// Copied from kition-sdk packages/kdm/src/errors.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** Every failure of the KDM, with the same reasons as the variants of the Rust `KdmError`. */
export type KdmErrorReason =
  | 'schema'
  | 'unknown-type'
  | 'unknown-field'
  | 'invalid-value'
  | 'not-found'
  | 'cycle'
  | 'out-of-range'
  | 'wrong-document'
  | 'encoding'
  | 'engine'

/** Bad input is a `KdmError`, never another exception. Messages read like the Rust ones. */
export class KdmError extends Error {
  readonly reason: KdmErrorReason

  constructor(reason: KdmErrorReason, message: string) {
    super(message)
    this.name = 'KdmError'
    this.reason = reason
  }
}

/** Constructors with the Rust `KdmError` display texts. */
export const errors = {
  schema: (message: string) => new KdmError('schema', `schema: ${message}`),
  unknownType: (ty: string) => new KdmError('unknown-type', `unknown type \`${ty}\``),
  unknownField: (ty: string, field: string) => new KdmError('unknown-field', `type \`${ty}\` has no field \`${field}\``),
  invalidValue: (ty: string, field: string, reason: string) => new KdmError('invalid-value', `field \`${field}\` of \`${ty}\` ${reason}`),
  notFound: (what: string) => new KdmError('not-found', `object \`${what}\` not found`),
  cycle: () => new KdmError('cycle', 'moving that node would create a cycle'),
  outOfRange: (index: number, len: number) => new KdmError('out-of-range', `index ${index} is out of range (length ${len})`),
  wrongDocument: (expected: string, found: string) => new KdmError('wrong-document', `the changes belong to document ${found}, not ${expected}`),
  encoding: (message: string) => new KdmError('encoding', `encoding: ${message}`),
  engine: (message: string) => new KdmError('engine', `engine: ${message}`),
}
