/**
 * Design templates as data: a package manifest under public/templates/design
 * lists resources of kind `design`, and each resource has a JSON layout with
 * named slots and brand bindings. Filling a template produces a fresh
 * DesignDocument; nothing here touches the store or the network beyond the
 * bundled assets.
 */
import { z } from 'zod'
import type { TemplatePackageContract, TemplatePackageResource } from '@/api/generated/template-package'
import { readBundledAssetText } from '@/lib/bundledAssets'
import { createDesign, createDesignNode, DESIGN_FONT_FAMILIES, type DesignDocument, type DesignNode } from './designTypes'

const DESIGN_TEMPLATE_PACKAGE_PATH = 'kition-bundled:/templates/design/manifest.json'
const DESIGN_TEMPLATE_DIR = 'kition-bundled:/templates/design'

export type DesignTemplateSlot = 'headline' | 'body' | 'label' | 'image' | 'logo' | 'accent'
export type DesignBrandBinding = 'primary' | 'accent' | 'text' | 'surface' | 'font'
/** The brand values a template can bind; the workspace brand kit supplies them. */
export type DesignBrandKit = {
  colors: Partial<Record<Exclude<DesignBrandBinding, 'font'>, string>>
  fontFamily?: DesignNode['fontFamily']
}

const color = z.string().regex(/^(#[\da-f]{6}|#[\da-f]{8}|transparent)$/i)
const colorBinding = z.enum(['primary', 'accent', 'text', 'surface'])
const layer = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    type: z.enum(['text', 'rectangle', 'ellipse', 'line']),
    name: z.string().max(200).optional(),
    slot: z.enum(['headline', 'body', 'label', 'image', 'logo', 'accent']).optional(),
    text: z.string().max(2000).optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWidth: z.number().finite().min(0).optional(),
    radius: z.number().finite().min(0).optional(),
    fontFamily: z.enum(DESIGN_FONT_FAMILIES).optional(),
    fontSize: z.number().finite().positive().optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().finite().positive().optional(),
    letterSpacing: z.number().finite().optional(),
    constraints: z
      .object({
        horizontal: z.enum(['left', 'center', 'right', 'scale']),
        vertical: z.enum(['top', 'center', 'bottom', 'scale']),
      })
      .optional(),
    brand: z
      .object({
        fill: colorBinding.optional(),
        stroke: colorBinding.optional(),
        font: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
const templateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    width: z.number().finite().positive().max(16384),
    height: z.number().finite().positive().max(16384),
    background: color,
    brand: z.object({ background: colorBinding.optional() }).strict().optional(),
    layers: z.array(layer).min(1).max(200),
  })
  .strict()
  .refine((value) => new Set(value.layers.map((entry) => entry.id)).size === value.layers.length, 'Layer ids must be unique')

export type DesignTemplate = z.infer<typeof templateSchema>

export function parseDesignTemplate(value: unknown): DesignTemplate {
  return templateSchema.parse(value)
}

/** Slots in layer order, each once. */
export function designTemplateSlots(template: DesignTemplate): DesignTemplateSlot[] {
  const slots: DesignTemplateSlot[] = []
  for (const entry of template.layers) if (entry.slot && !slots.includes(entry.slot)) slots.push(entry.slot)
  return slots
}

/** Brand bindings the template declares, in layer order, page background last. */
export function designTemplateBrandBindings(template: DesignTemplate): DesignBrandBinding[] {
  const bindings: DesignBrandBinding[] = []
  const add = (binding?: DesignBrandBinding) => {
    if (binding && !bindings.includes(binding)) bindings.push(binding)
  }
  for (const entry of template.layers) {
    add(entry.brand?.fill)
    add(entry.brand?.stroke)
    if (entry.brand?.font) add('font')
  }
  add(template.brand?.background)
  return bindings
}

/**
 * Builds a document from a template. Slot text replaces the template copy,
 * and a brand kit replaces every bound color and font it defines; unbound
 * values and undefined brand entries keep the template's own.
 */
export function fillDesignTemplate(
  template: DesignTemplate,
  options: { slots?: Partial<Record<DesignTemplateSlot, string>>; brand?: DesignBrandKit; title?: string } = {},
): DesignDocument {
  const doc = createDesign(options.title ?? template.name, template.width, template.height)
  const page = doc.pages[0]
  const brandColor = (binding?: DesignBrandBinding) =>
    binding && binding !== 'font' ? options.brand?.colors[binding] : undefined
  page.background = brandColor(template.brand?.background) ?? template.background
  for (const entry of template.layers) {
    const { id: _id, x, y, slot, brand, text, name, ...rest } = entry
    const value = (slot && options.slots?.[slot]) ?? text ?? ''
    const node = createDesignNode(entry.type, {
      ...rest,
      name: name ?? (entry.type === 'text' ? value : entry.type),
      text: entry.type === 'text' ? value : '',
      transform: [1, 0, 0, 1, x, y],
    })
    const fill = brandColor(brand?.fill)
    if (fill) node.fill = fill
    const stroke = brandColor(brand?.stroke)
    if (stroke) node.stroke = stroke
    if (brand?.font && options.brand?.fontFamily) node.fontFamily = options.brand.fontFamily
    doc.nodes[node.id] = node
    page.children.push(node.id)
  }
  doc.provenance = { templateId: `design-template-${template.id}`, templateVersion: template.version }
  return doc
}

export type DesignTemplatePackage = {
  manifest: TemplatePackageContract
  templates: Array<{ resource: TemplatePackageResource; template: DesignTemplate }>
}

/** Reads the bundled package and every design resource it lists. */
export async function loadDesignTemplatePackage(
  readText: (path: string) => Promise<string> = readBundledAssetText,
): Promise<DesignTemplatePackage> {
  const manifest = JSON.parse(await readText(DESIGN_TEMPLATE_PACKAGE_PATH)) as TemplatePackageContract
  const resources = manifest.resources.filter((resource) => resource.kind === 'design')
  const templates = await Promise.all(
    resources.map(async (resource) => ({
      resource,
      template: parseDesignTemplate(JSON.parse(await readText(`${DESIGN_TEMPLATE_DIR}/${resource.id}.json`))),
    })),
  )
  return { manifest, templates }
}
