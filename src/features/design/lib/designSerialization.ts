import { z } from 'zod'
import { DESIGN_MAX_NODES, type DesignDocument } from './designTypes'
const finite = z.number().finite().min(-1e7).max(1e7)
const dimension = z.number().finite().positive().max(16384)
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value))
const color = z.string().regex(/^(#[\da-f]{6}|#[\da-f]{8}|transparent)$/i)
const bounds = z.object({
  x: finite,
  y: finite,
  width: dimension,
  height: dimension,
})
const node = z
  .object({
    id,
    name: z.string().max(1000),
    type: z.enum(['text', 'image', 'rectangle', 'ellipse', 'line', 'group']),
    transform: z
      .tuple([finite, finite, finite, finite, finite, finite])
      .refine((m) => Math.abs(m[0] * m[3] - m[1] * m[2]) >= 1e-8),
    width: dimension,
    height: dimension,
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
    locked: z.boolean(),
    fill: color,
    stroke: color,
    strokeWidth: z.number().min(0).max(1000),
    radius: z.number().min(0).max(8192),
    text: z.string().max(50000),
    fontFamily: z.enum(['Arial', 'Georgia', 'Courier New']),
    fontSize: z.number().min(1).max(2000),
    fontWeight: z.number().int().min(100).max(900),
    textAlign: z.enum(['left', 'center', 'right']),
    lineHeight: z.number().min(0.5).max(4),
    letterSpacing: z.number().min(-100).max(500),
    assetId: id.optional(),
    crop: bounds.optional(),
    children: z.array(id).max(DESIGN_MAX_NODES),
  })
  .strict()
export function isPortableDesignPath(value: string) {
  return (
    !!value &&
    !/[:\\?#\u0000-\u001f]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((p) => p && p !== '.' && p !== '..')
  )
}
const schema = z
  .object({
    format: z.literal('kition-design'),
    version: z.literal(1),
    id,
    title: z.string().max(1000),
    revision: z.number().int().nonnegative(),
    pages: z.tuple([
      z
        .object({
          id,
          width: dimension,
          height: dimension,
          background: color,
          children: z.array(id).max(DESIGN_MAX_NODES),
        })
        .strict(),
    ]),
    nodes: z
      .record(id, node)
      .refine((nodes) => Object.keys(nodes).length <= DESIGN_MAX_NODES),
    assets: z.record(
      id,
      z
        .object({
          id,
          path: z.string().max(2000).refine(isPortableDesignPath),
          mimeType: z.enum([
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
          ]),
          width: dimension,
          height: dimension,
        })
        .strict(),
    ),
    provenance: z
      .object({
        templateId: z.string().max(200).optional(),
        templateVersion: z.number().int().positive().optional(),
        imagePath: z.string().refine(isPortableDesignPath).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export function validateDesign(value: unknown): DesignDocument {
  const doc = schema.parse(value) as DesignDocument
  const visited = new Set<string>()
  function visit(ids: string[], depth: number) {
    if (depth > 32) throw new Error('Design nesting limit exceeded')
    for (const nodeId of ids) {
      const n = doc.nodes[nodeId]
      if (!n || n.id !== nodeId || visited.has(nodeId))
        throw new Error('Invalid design hierarchy')
      visited.add(nodeId)
      if (n.type !== 'group' && n.children.length)
        throw new Error('Only groups can contain layers')
      if (n.type === 'image') {
        const asset = doc.assets[n.assetId || '']
        if (!asset || asset.id !== n.assetId || !n.crop)
          throw new Error('Missing image asset record')
        if (
          n.crop.x < 0 ||
          n.crop.y < 0 ||
          n.crop.x + n.crop.width > asset.width + 0.01 ||
          n.crop.y + n.crop.height > asset.height + 0.01
        )
          throw new Error('Invalid image crop')
      }
      visit(n.children, depth + 1)
    }
  }
  visit(doc.pages[0].children, 0)
  if (visited.size !== Object.keys(doc.nodes).length)
    throw new Error('Unattached design layers')
  for (const [key, asset] of Object.entries(doc.assets))
    if (key !== asset.id) throw new Error('Invalid asset ID')
  return doc
}
export function parseDesign(content: string): DesignDocument {
  if (content.length > 20_000_000) throw new Error('Design file is too large')
  const value: unknown = JSON.parse(content)
  if (
    typeof value === 'object' &&
    value &&
    'version' in value &&
    value.version !== 1
  )
    throw new Error('Unsupported design version')
  return validateDesign(value)
}
export const serializeDesign = (doc: DesignDocument) =>
  JSON.stringify(validateDesign(doc), null, 2) + '\n'
