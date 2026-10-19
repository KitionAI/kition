// Copied from kition-sdk packages/convergence/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `@kition/convergence`: the convergence suite of the Kition Kit Standard 2.0 (section 11) for
 * TypeScript engines, what a `ts-worker` kit runs to claim L6. The same 17 scenarios, pass and
 * skip rules, and report as the Rust `kition-convergence` crate, driven through a `KitAdapter`;
 * `KitEngineAdapter` does the replica part for engines made with `@kition/kit-engine`.
 *
 * ```ts
 * it('converges', () => {
 *   const report = run(new MyKit(), DEFAULT_OPTIONS)
 *   saveReportIfRequested(report) // from '@kition/convergence/node'
 *   expect(report.level6(), report.render()).toBe(true)
 * })
 * ```
 */
export { DEFAULT_OPTIONS, describeStep, optionsFromEnv, type Blobs, type KitAdapter, type Options, type Script } from './adapter'
export { decodeBlobBundle, encodeBlobBundle, KitEngineAdapter, utf16Index, type EngineClass, type EngineDocument, type KitEngineAdapterOptions } from './engine'
export { bytesEqual, Net, Skip } from './net'
export { Report, SUITE, type Check, type Outcome, type ReportJson } from './report'
export { Rng } from './rng'
export { run, runOne, SCENARIOS } from './scenarios'
export {
  checkReferences,
  compareStrings,
  created,
  deleted,
  digest,
  firstDifference,
  isRegister,
  listSets,
  objects,
  register,
  registerChanges,
  Registers,
  sameValue,
  SchemaInfo,
  treeNodes,
  type FieldInfo,
  type Slot,
} from './state'
