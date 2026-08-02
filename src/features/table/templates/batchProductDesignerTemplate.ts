import type { TFunction } from 'i18next'

import type {
  KitableTemplateAssetReference,
  KitableTemplateSeed,
  KitableTemplateViewFieldLayout,
} from './kitableTemplates'

const ORTHOGRAPHIC_VIEWS_PROMPT = `Create an original, photorealistic industrial-design orthographic presentation of the exact product shown in the attached reference designs.

Product: {{Concept}}
Brief: {{Concept description}}

Preserve the same product geometry, materials, colors, controls, and proportions. Show front, side, rear, and top views aligned on a clean warm-white studio background with consistent scale and neutral lighting. Add only faint construction guide lines; no dimensions, labels, logos, or decorative text.`

const FEATURE_IMAGE_PROMPT = `Create an original commercial feature image of the exact product shown in the attached reference designs.

Product: {{Concept}}
Brief: {{Concept description}}

Use one premium three-quarter product hero shot on a light neutral background. Surround it with three restrained visual callouts using simple icons and thin leader lines that communicate the product's most important functions. Do not render words, labels, logos, trademarks, or watermarks. Preserve the reference product exactly.`

const LIFESTYLE_SHOT_PROMPT = `Create an original photorealistic lifestyle campaign image featuring the exact product shown in the attached reference designs.

Product: {{Concept}}
Brief: {{Concept description}}

Choose a believable everyday setting where this product is naturally useful. Show a person interacting with it in a relaxed, unscripted way, while keeping the product clearly visible and consistent with the reference. Natural daylight, realistic materials and skin texture, balanced commercial composition, no logos, no text, no watermark.`

const STYLE_BOARD_PROMPT = `Create an original four-panel product style board for the exact product shown in the attached reference designs.

Product: {{Concept}}
Brief: {{Concept description}}

Panel 1: clean hero view. Panel 2: close material and control detail. Panel 3: compact lifestyle context. Panel 4: packaging-ready still life with complementary materials. Keep the same product geometry, colors, and materials in every panel. Clean editorial grid, light neutral background, no labels, no logos, no text, no watermark.`

const LINKEDIN_COPY_PROMPT = `Act as a product launch editor. Write one clear LinkedIn post for {{Concept}} using this brief: {{Concept description}}.

Explain the practical user benefit, mention two concrete design details, and close with a concise product point of view. Keep it natural, original, and below 400 characters. Do not use hashtags, invented claims, or placeholder branding. Return only the finished post.`

const TWITTER_COPY_PROMPT = `Write one original short-form launch post for {{Concept}} using this brief: {{Concept description}}.

Lead with the user benefit, mention two concrete product details, and keep the full post below 280 characters. Use plain English and restrained line breaks. Do not use hashtags, placeholder branding, or more than one emoji. Return only the finished post.`

const assetReferences = (...assetIds: string[]): KitableTemplateAssetReference => ({ assetIds })

const gridLayouts: KitableTemplateViewFieldLayout[] = [
  { fieldTitle: 'Concept', position: 0, width: 180, frozen: true },
  { fieldTitle: 'Concept description', position: 1, width: 300 },
  { fieldTitle: 'Designs', position: 2, width: 420 },
  { fieldTitle: 'Orthographic views', position: 3, width: 280 },
  { fieldTitle: 'Feature image', position: 4, width: 280 },
  { fieldTitle: 'Lifestyle shot', position: 5, width: 280 },
  { fieldTitle: 'Style board', position: 6, width: 280 },
  { fieldTitle: 'LinkedIn copy', position: 7, width: 280 },
  { fieldTitle: 'Twitter copy', position: 8, width: 280 },
]

export function createBatchProductDesignerTemplate(
  t: TFunction<'table'>,
): KitableTemplateSeed {
  return {
    id: 'batch-product-designer',
    title: t('templateLibrary.templates.batchProductDesigner.title'),
    description: t('templateLibrary.templates.batchProductDesigner.description'),
    documentDescription: 'Turn original product concepts into consistent design studies, campaign imagery, and launch copy.',
    usageCount: 0,
    icon: 'palette',
    color: 'amber',
    assetManifestPath: 'kition-bundled:/templates/batch-product-designer/manifest.json',
    tables: [{
      title: 'Product Concepts',
      description: 'Original product briefs, generated design assets, campaign imagery, and social copy.',
      fields: [
        {
          title: 'Concept',
          name: 'concept',
          type: 'long_text',
          primary: true,
        },
        {
          title: 'Concept description',
          name: 'concept_description',
          type: 'long_text',
        },
        {
          title: 'Designs',
          name: 'designs',
          type: 'attachment',
          aiConfig: {
            type: 'image_generation',
            sourceFieldTitle: 'Concept description',
            enabled: true,
            auto_update: true,
            n: 2,
            quality: 'high',
            aspect_ratio: '4:3',
            resolution: '1K',
            image_use_case: 'product_showcase',
          },
        },
        {
          title: 'Orthographic views',
          name: 'orthographic_views',
          type: 'attachment',
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Designs',
            prompt: ORTHOGRAPHIC_VIEWS_PROMPT,
            enabled: true,
            auto_update: true,
            n: 1,
            quality: 'high',
            aspect_ratio: '16:9',
            resolution: '1K',
            image_use_case: 'product_showcase',
          },
        },
        {
          title: 'Feature image',
          name: 'feature_image',
          type: 'attachment',
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Designs',
            prompt: FEATURE_IMAGE_PROMPT,
            enabled: true,
            auto_update: true,
            n: 1,
            quality: 'high',
            aspect_ratio: '16:9',
            resolution: '1K',
            image_use_case: 'infographic_diagram',
          },
        },
        {
          title: 'Lifestyle shot',
          name: 'lifestyle_shot',
          type: 'attachment',
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Designs',
            prompt: LIFESTYLE_SHOT_PROMPT,
            enabled: true,
            auto_update: true,
            n: 1,
            quality: 'high',
            aspect_ratio: '16:9',
            resolution: '1K',
            image_use_case: 'product_showcase',
          },
        },
        {
          title: 'Style board',
          name: 'style_board',
          type: 'attachment',
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Designs',
            prompt: STYLE_BOARD_PROMPT,
            enabled: true,
            auto_update: true,
            n: 1,
            quality: 'high',
            aspect_ratio: '16:9',
            resolution: '1K',
            image_use_case: 'product_showcase',
          },
        },
        {
          title: 'LinkedIn copy',
          name: 'linkedin_copy',
          type: 'long_text',
          aiConfig: {
            type: 'customize',
            prompt: LINKEDIN_COPY_PROMPT,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Twitter copy',
          name: 'twitter_copy',
          type: 'long_text',
          aiConfig: {
            type: 'customize',
            prompt: TWITTER_COPY_PROMPT,
            enabled: true,
            auto_update: true,
          },
        },
      ],
      views: [{
        title: 'Grid View',
        type: 'grid',
        config: { row_height: 'extra_tall', frozen_column_count: 1 },
        fieldLayouts: gridLayouts,
      }],
      records: [
        {
          Concept: 'HaloFold Reading Light',
          'Concept description': 'A portable fold-flat reading lamp built from recycled aluminum. A slim oval light frame pivots around a compact hinge, with warm diffused LEDs, a pebble-gray body, one restrained violet hinge accent, USB-C charging, and a soft-touch base. Clean, quiet, repairable, and designed for bedside reading or travel. No visible branding or text.',
          Designs: assetReferences('record-01-design-01', 'record-01-design-02'),
          'Orthographic views': assetReferences('record-01-orthographic-views-01'),
          'Feature image': assetReferences('record-01-feature-image-01'),
          'Lifestyle shot': assetReferences('record-01-lifestyle-shot-01'),
          'Style board': assetReferences('record-01-style-board-01'),
          'LinkedIn copy': 'Meet HaloFold: a recycled-aluminum reading light that folds flat for travel, opens into a warm focused glow, and keeps bedside spaces calm. A tactile hinge, USB-C charging, and repairable construction make quiet design genuinely useful.',
          'Twitter copy': 'A reading light that folds flat.\n\nWarm diffused glow, recycled aluminum, tactile hinge, USB-C power. HaloFold is made for calm desks, bedside reading, and travel bags.',
        },
        {
          Concept: 'MossDrop Indoor Garden',
          'Concept description': 'A compact countertop herb garden with four modular hexagonal planting pods. Fog-white recycled plastic shell, removable sage-green grow trays, hidden water reservoir, gentle full-spectrum light arch, and tiny amber status indicators. Friendly domestic design for apartments, with no screen, logo, or decorative text.',
          Designs: assetReferences('record-02-design-01', 'record-02-design-02'),
          'Orthographic views': assetReferences('record-02-orthographic-views-01'),
          'Feature image': assetReferences('record-02-feature-image-01'),
          'Lifestyle shot': assetReferences('record-02-lifestyle-shot-01'),
          'Style board': assetReferences('record-02-style-board-01'),
          'LinkedIn copy': 'MossDrop brings a small edible garden to the kitchen counter. Four modular pods, a hidden reservoir, and a gentle light arch make growing herbs approachable without adding another screen to the home.',
          'Twitter copy': 'Four herb pods. One quiet countertop garden.\n\nMossDrop uses a hidden reservoir and gentle grow light to make fresh herbs easy in small homes.',
        },
        {
          Concept: 'DriftPod Travel Speaker',
          'Concept description': 'A palm-sized waterproof travel speaker shaped like a softly rounded triangular pebble. Deep plum recycled-aluminum mesh, sand-colored silicone edge, integrated woven carry loop, three tactile top buttons, and a subtle warm-white status line. Rugged but refined, with no logo or text.',
          Designs: assetReferences('record-03-design-01', 'record-03-design-02'),
          'Orthographic views': assetReferences('record-03-orthographic-views-01'),
          'Feature image': assetReferences('record-03-feature-image-01'),
          'Lifestyle shot': assetReferences('record-03-lifestyle-shot-01'),
          'Style board': assetReferences('record-03-style-board-01'),
          'LinkedIn copy': 'DriftPod is a travel speaker designed around the moments between destinations: compact, waterproof, easy to clip onto a bag, and tactile enough to use without looking at a screen.',
          'Twitter copy': 'Pocket-sized sound for the road.\n\nDriftPod pairs recycled aluminum, a waterproof shell, tactile controls, and a built-in carry loop.',
        },
        {
          Concept: 'QuietKey Focus Timer',
          'Concept description': 'A compact desktop focus timer with an ivory ceramic-like body, rotating brushed-aluminum dial, circular monochrome e-ink display, one small violet progress marker, and silent tactile controls. Minimal, distraction-free, softly rounded, and designed for deep work. No logo or extra text.',
          Designs: assetReferences('record-04-design-01', 'record-04-design-02'),
          'Orthographic views': assetReferences('record-04-orthographic-views-01'),
          'Feature image': assetReferences('record-04-feature-image-01'),
          'Lifestyle shot': assetReferences('record-04-lifestyle-shot-01'),
          'Style board': assetReferences('record-04-style-board-01'),
          'LinkedIn copy': 'QuietKey turns focus into a physical ritual. Rotate the aluminum dial, set a session on the e-ink display, and work without notifications, glowing dashboards, or another app competing for attention.',
          'Twitter copy': 'Turn the dial. Start the session.\n\nQuietKey is a silent e-ink focus timer with tactile controls and zero notifications.',
        },
        {
          Concept: 'BrewFold Tea Bottle',
          'Concept description': 'A double-wall glass tea bottle with a collapsible terracotta silicone sleeve, magnetic stainless-steel infuser cap, removable fine-mesh basket, and flexible carry loop. The sleeve expands for grip and folds flat for storage. Warm, practical travel design with no logo or printed text.',
          Designs: assetReferences('record-05-design-01', 'record-05-design-02'),
          'Orthographic views': assetReferences('record-05-orthographic-views-01'),
          'Feature image': assetReferences('record-05-feature-image-01'),
          'Lifestyle shot': assetReferences('record-05-lifestyle-shot-01'),
          'Style board': assetReferences('record-05-style-board-01'),
          'LinkedIn copy': 'BrewFold makes loose-leaf tea easier to carry. Its protective silicone sleeve expands for grip, folds down for storage, and pairs with a magnetic infuser cap for a cleaner travel ritual.',
          'Twitter copy': 'Loose-leaf tea, packed smaller.\n\nBrewFold combines double-wall glass, a magnetic infuser, and a protective sleeve that collapses for travel.',
        },
      ],
    }],
  }
}
