// Copied from kition-sdk packages/kdm/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
export {
  BatchError,
  batchOrigin,
  describeModel,
  OBJECT_MODEL_CAPABILITY,
  readField,
  replicaTarget,
  resolveValues,
  rootId,
  runBatch,
  type BatchErrorCode,
  type BatchLoad,
  type BatchOp,
  type BatchRequest,
  type BatchResult,
  type BatchTarget,
  type LoadedObject,
} from './batch'
export { canonicalText } from './canonical'
export { KdmError, type KdmErrorReason } from './errors'
export { newDocId, newObjectId, NodeRef, randomActor, uuidFromBytes, uuidToBytes, uuidV7, type ObjectId, type TreeEntry } from './ids'
export { agent, decodeOrigin, encodeOrigin, person, system, type Origin, type OriginKind } from './origin'
export { open as openEnvelope, Version } from './envelope'
export type { TextRun } from './marks'
export { Replica, type TextDelta } from './replica'
export { checkValue, fieldDef, hasMarks, isContainer, KDM_VERSION, parseSchema, typeDef, type Expand, type FieldDef, type FieldKind, type MarkDef, type Schema, type TypeDef } from './schema'
export { Network, Rng } from './testing'
export { Tx } from './tx'
export type { JsonValue } from './value'
