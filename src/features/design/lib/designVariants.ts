/**
 * Size variants: one design, several artboard sizes that share every layer
 * and differ only in geometry overrides. The primary artboard is the base;
 * a variant is resolved into a full document view for editing and export,
 * and edits on that view fold back into the base plus overrides.
 */
import { applyDesignCommand } from './designCommands'
import type { DesignDocument, DesignNode, DesignVariant, DesignVariantOverride } from './designTypes'
import { designId } from './designTypes'

/** The layer fields a variant may override; everything else stays shared. */
const VARIANT_KEYS = ['transform', 'width', 'height', 'visible', 'fontSize', 'lineHeight', 'constraints'] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The document as one variant sees it; the base itself when `variantId` is null or unknown. */
export function resolveDesignVariant(doc: DesignDocument, variantId: string | null): DesignDocument {
  const variant = variantId ? doc.variants?.[variantId] : undefined
  if (!variant) return doc
  const nodes: DesignDocument['nodes'] = {}
  for (const [id, node] of Object.entries(doc.nodes)) nodes[id] = { ...node, ...variant.overrides[id] }
  return {
    ...doc,
    pages: [{ ...doc.pages[0], width: variant.width, height: variant.height, background: variant.background ?? doc.pages[0].background }],
    nodes,
  }
}

/**
 * Folds an edited view back into the base. Shared fields flow to the base
 * layer; overridable fields that differ from the base become the variant's
 * overrides; new layers join the base as they are and removed layers leave
 * every variant. With no variant active the view simply becomes the base.
 */
export function foldDesignVariant(base: DesignDocument, view: DesignDocument, variantId: string | null): DesignDocument {
  const variant = variantId ? base.variants?.[variantId] : undefined
  if (!variant) return pruneOverrides(view)
  const nodes: DesignDocument['nodes'] = {}
  const overrides: DesignVariant['overrides'] = {}
  for (const [id, viewNode] of Object.entries(view.nodes)) {
    const baseNode = base.nodes[id]
    if (!baseNode) {
      nodes[id] = viewNode
      continue
    }
    const shared = { ...viewNode } as DesignNode
    const override: DesignVariantOverride = {}
    const sharedFields = shared as Record<string, unknown>
    const overrideFields = override as Record<string, unknown>
    for (const key of VARIANT_KEYS) {
      sharedFields[key] = baseNode[key]
      if (!same(viewNode[key], baseNode[key])) overrideFields[key] = viewNode[key]
    }
    if (baseNode.constraints === undefined && shared.constraints === undefined) delete shared.constraints
    nodes[id] = shared
    if (Object.keys(override).length) overrides[id] = override
  }
  const nextVariant: DesignVariant = {
    ...variant,
    width: view.pages[0].width,
    height: view.pages[0].height,
    background: view.pages[0].background === base.pages[0].background ? undefined : view.pages[0].background,
    overrides,
  }
  if (nextVariant.background === undefined) delete nextVariant.background
  return pruneOverrides({
    ...view,
    pages: [{ ...view.pages[0], width: base.pages[0].width, height: base.pages[0].height, background: base.pages[0].background }],
    nodes,
    variants: { ...base.variants, [variant.id]: nextVariant },
  })
}

/** Drops overrides for layers that no longer exist. */
function pruneOverrides(doc: DesignDocument): DesignDocument {
  if (!doc.variants) return doc
  const variants: Record<string, DesignVariant> = {}
  for (const [id, variant] of Object.entries(doc.variants)) {
    const overrides: DesignVariant['overrides'] = {}
    for (const [nodeId, override] of Object.entries(variant.overrides)) if (doc.nodes[nodeId]) overrides[nodeId] = override
    variants[id] = { ...variant, overrides }
  }
  return { ...doc, variants }
}

/**
 * Adds a variant of the given size. Layers reflow from the primary artboard
 * by their constraints, and the result is stored as this variant's overrides.
 */
export function createDesignVariant(
  doc: DesignDocument,
  input: { name: string; width: number; height: number },
): { document: DesignDocument; variantId: string } {
  const id = designId()
  const withVariant: DesignDocument = {
    ...doc,
    variants: {
      ...doc.variants,
      [id]: { id, name: input.name, width: doc.pages[0].width, height: doc.pages[0].height, overrides: {} },
    },
  }
  const reflowed = applyDesignCommand(resolveDesignVariant(withVariant, id), {
    type: 'page',
    patch: { width: input.width, height: input.height },
  })
  return { document: foldDesignVariant(withVariant, reflowed, id), variantId: id }
}

export function removeDesignVariant(doc: DesignDocument, variantId: string): DesignDocument {
  if (!doc.variants?.[variantId]) return doc
  const { [variantId]: _removed, ...variants } = doc.variants
  return { ...doc, variants }
}

/** Primary first, then variants in creation order, for menus and batch export. */
export function designVariantList(doc: DesignDocument): Array<{ id: string | null; name: string; width: number; height: number }> {
  return [
    { id: null, name: '', width: doc.pages[0].width, height: doc.pages[0].height },
    ...Object.values(doc.variants ?? {}).map((variant) => ({ id: variant.id, name: variant.name, width: variant.width, height: variant.height })),
  ]
}
