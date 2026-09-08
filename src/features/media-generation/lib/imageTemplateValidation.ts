import { z } from 'zod'

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const publicURL = z.url().max(2048).refine((url) => /^https:\/\//i.test(url))
export const imageTemplateSchema = z.object({
  id: identifier,
  version: identifier,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  operation: z.enum(['generate', 'edit']),
  category: identifier,
  thumbnail: z.object({
    url: publicURL,
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    blurhash: z.string().min(1).max(200).optional(),
  }),
  default_aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2']),
  default_quality: z.enum(['low', 'medium', 'high']),
  default_resolution: z.enum(['1K', '2K', '4K']),
  default_text_mode: z.enum(['editable_overlay', 'baked_text', 'no_text']),
  requires_reference_image: z.boolean(),
  access: z.enum(['public', 'account', 'premium']),
  variables: z.array(z.object({
    key: identifier,
    label: z.string().min(1).max(120),
    placeholder: z.string().max(500).optional(),
    required: z.boolean(),
    multiline: z.boolean(),
  })).max(32).refine((items) => new Set(items.map((item) => item.key)).size === items.length),
  tags: z.array(z.string().min(1).max(100)).max(32),
  source: z.object({
    license: z.string().min(1).max(100),
    label: z.string().min(1).max(300),
    url: publicURL.optional(),
  }).optional(),
})
export const imageTemplateCatalogSchema = z.object({
  catalog_revision: identifier,
  total_count: z.number().int().nonnegative().optional(),
  next_cursor: z.string().min(1).max(512).optional(),
  items: z.array(imageTemplateSchema).max(100),
})
