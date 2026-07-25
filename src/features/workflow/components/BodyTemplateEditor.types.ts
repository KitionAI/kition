export interface FieldSchema { id: string; name: string; type: string }
export interface TableSchema { id: string; name: string; fields: FieldSchema[] }
export interface FieldRef { nodeId: string; fieldId: string }
export type BodyPart =
  | { kind: 'text'; text: string }
  | { kind: 'newline' }
  | { kind: 'field_ref'; fieldRef: FieldRef }
export interface BodyTemplate { parts: BodyPart[] }
