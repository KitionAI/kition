export type { BodyPart, BodyTemplate } from '@/api/workflows'
export interface FieldSchema { id: string; name: string; type: string }
export interface TableSchema { id: string; name: string; fields: FieldSchema[] }
