import brandTouchpointBoardThumbnail from '../assets/image-templates/brand-touchpoint-board.webp'
import characterProductionSheetThumbnail from '../assets/image-templates/character-production-sheet.webp'
import doodleCharacterThumbnail from '../assets/image-templates/doodle-character.webp'
import editorialSilhouettePosterThumbnail from '../assets/image-templates/editorial-silhouette-poster.webp'
import engineeringInfographicThumbnail from '../assets/image-templates/engineering-infographic.webp'
import landmarkTypePosterThumbnail from '../assets/image-templates/landmark-type-poster.webp'
import miniatureProductCampaignThumbnail from '../assets/image-templates/miniature-product-campaign.webp'
import mixedMediaMemoryCardThumbnail from '../assets/image-templates/mixed-media-memory-card.webp'
import neonCreatorPosterThumbnail from '../assets/image-templates/neon-creator-poster.webp'
import paperCollagePortraitThumbnail from '../assets/image-templates/paper-collage-portrait.webp'
import photoDoodleMixThumbnail from '../assets/image-templates/photo-doodle-mix.webp'
import productConceptBoardThumbnail from '../assets/image-templates/product-concept-board.webp'
import surrealCityPosterThumbnail from '../assets/image-templates/surreal-city-poster.webp'
import travelFieldNotesThumbnail from '../assets/image-templates/travel-field-notes.webp'
import vintageTravelPosterThumbnail from '../assets/image-templates/vintage-travel-poster.webp'
import vocabularyLearningCardThumbnail from '../assets/image-templates/vocabulary-learning-card.webp'

export const IMAGE_PROMPT_TEMPLATE_IDS = [
  'surreal-city-poster',
  'miniature-product-campaign',
  'engineering-infographic',
  'landmark-type-poster',
  'brand-touchpoint-board',
  'neon-creator-poster',
  'vintage-travel-poster',
  'product-concept-board',
  'vocabulary-learning-card',
  'editorial-silhouette-poster',
  'mixed-media-memory-card',
  'travel-field-notes',
  'paper-collage-portrait',
  'photo-doodle-mix',
  'doodle-character',
  'character-production-sheet',
] as const

export const IMAGE_PROMPT_TEMPLATE_CATEGORIES = [
  'all',
  'poster',
  'product',
  'brand',
  'education',
  'character',
  'editing',
] as const

export type ImagePromptTemplateId = typeof IMAGE_PROMPT_TEMPLATE_IDS[number]
export type ImagePromptOperation = 'generate' | 'edit'
export type ImagePromptTextMode = 'editable_overlay' | 'baked_text' | 'no_text'
export type ImagePromptAspectRatio =
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '2:3'
  | '3:2'
export type ImagePromptTemplateView = 'recommended' | 'all' | 'generate' | 'edit'
export type ImagePromptTemplateCategory = Exclude<
  typeof IMAGE_PROMPT_TEMPLATE_CATEGORIES[number],
  'all'
>
export type ImagePromptTemplateCategoryFilter =
  typeof IMAGE_PROMPT_TEMPLATE_CATEGORIES[number]
export type ImagePromptVariableKey = 'subject' | 'scene' | 'details' | 'palette'
export type ImagePromptVariableValues = Record<ImagePromptVariableKey, string>

export type ImagePromptTemplateSource = {
  caseId: number
  imagePath: string
  license: 'MIT'
  path: string
  repository: string
  url: string
}

export type ImagePromptTemplateVariable = {
  key: ImagePromptVariableKey
  multiline?: boolean
  required?: boolean
}

export type ImagePromptTemplateDefinition = {
  id: ImagePromptTemplateId
  category: ImagePromptTemplateCategory
  operation: ImagePromptOperation
  defaultAspectRatio: ImagePromptAspectRatio
  defaultTextMode: ImagePromptTextMode
  thumbnail: string
  variables: readonly ImagePromptTemplateVariable[]
  styles: readonly string[]
  scenes: readonly string[]
  source: ImagePromptTemplateSource
}

function image2CaseSource(caseId: number): ImagePromptTemplateSource {
  const path = `docs/gallery-part-2.md#case-${caseId}`
  return {
    caseId,
    imagePath: `data/images/case${caseId}.jpg`,
    license: 'MIT',
    path,
    repository: 'freestylefly/awesome-gpt-image-2',
    url: `https://github.com/freestylefly/awesome-gpt-image-2/blob/main/${path}`,
  }
}

export const IMAGE_PROMPT_TEMPLATES: readonly ImagePromptTemplateDefinition[] = [
  {
    id: 'surreal-city-poster',
    category: 'poster',
    operation: 'generate',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'editable_overlay',
    thumbnail: surrealCityPosterThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'scene', multiline: true },
      { key: 'palette' },
    ],
    styles: ['editorial', 'surreal', 'travel poster'],
    scenes: ['travel', 'creative'],
    source: image2CaseSource(540),
  },
  {
    id: 'miniature-product-campaign',
    category: 'product',
    operation: 'generate',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'baked_text',
    thumbnail: miniatureProductCampaignThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'scene', multiline: true },
      { key: 'palette' },
    ],
    styles: ['commercial', 'miniature', 'realistic'],
    scenes: ['commerce', 'social'],
    source: image2CaseSource(532),
  },
  {
    id: 'engineering-infographic',
    category: 'education',
    operation: 'generate',
    defaultAspectRatio: '1:1',
    defaultTextMode: 'baked_text',
    thumbnail: engineeringInfographicThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['infographic', 'technical', 'editorial'],
    scenes: ['tech', 'education'],
    source: image2CaseSource(494),
  },
  {
    id: 'landmark-type-poster',
    category: 'poster',
    operation: 'generate',
    defaultAspectRatio: '2:3',
    defaultTextMode: 'baked_text',
    thumbnail: landmarkTypePosterThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['typography', 'vector', 'travel poster'],
    scenes: ['travel', 'creative'],
    source: image2CaseSource(511),
  },
  {
    id: 'brand-touchpoint-board',
    category: 'brand',
    operation: 'generate',
    defaultAspectRatio: '3:2',
    defaultTextMode: 'baked_text',
    thumbnail: brandTouchpointBoardThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['brand system', 'moodboard', 'realistic'],
    scenes: ['commerce', 'food'],
    source: image2CaseSource(362),
  },
  {
    id: 'neon-creator-poster',
    category: 'poster',
    operation: 'generate',
    defaultAspectRatio: '9:16',
    defaultTextMode: 'editable_overlay',
    thumbnail: neonCreatorPosterThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['3D', 'neon', 'commercial poster'],
    scenes: ['tech', 'social'],
    source: image2CaseSource(503),
  },
  {
    id: 'vintage-travel-poster',
    category: 'poster',
    operation: 'generate',
    defaultAspectRatio: '2:3',
    defaultTextMode: 'editable_overlay',
    thumbnail: vintageTravelPosterThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['vintage', 'cinematic', 'travel poster'],
    scenes: ['travel', 'history'],
    source: image2CaseSource(515),
  },
  {
    id: 'product-concept-board',
    category: 'product',
    operation: 'generate',
    defaultAspectRatio: '3:2',
    defaultTextMode: 'baked_text',
    thumbnail: productConceptBoardThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['industrial design', '3D', 'concept board'],
    scenes: ['tech', 'education'],
    source: image2CaseSource(370),
  },
  {
    id: 'vocabulary-learning-card',
    category: 'education',
    operation: 'generate',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'baked_text',
    thumbnail: vocabularyLearningCardThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details' },
      { key: 'palette' },
    ],
    styles: ['learning card', 'realistic', 'minimal'],
    scenes: ['education'],
    source: image2CaseSource(544),
  },
  {
    id: 'editorial-silhouette-poster',
    category: 'poster',
    operation: 'generate',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'baked_text',
    thumbnail: editorialSilhouettePosterThumbnail,
    variables: [
      { key: 'subject', required: true },
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['typography', 'ink', 'editorial'],
    scenes: ['fashion', 'creative'],
    source: image2CaseSource(542),
  },
  {
    id: 'mixed-media-memory-card',
    category: 'editing',
    operation: 'edit',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'editable_overlay',
    thumbnail: mixedMediaMemoryCardThumbnail,
    variables: [
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['mixed media', 'memory card', 'handmade'],
    scenes: ['social', 'creative'],
    source: image2CaseSource(541),
  },
  {
    id: 'travel-field-notes',
    category: 'editing',
    operation: 'edit',
    defaultAspectRatio: '4:3',
    defaultTextMode: 'baked_text',
    thumbnail: travelFieldNotesThumbnail,
    variables: [
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['field notes', 'rubber stamp', 'realistic'],
    scenes: ['travel', 'creative'],
    source: image2CaseSource(538),
  },
  {
    id: 'paper-collage-portrait',
    category: 'editing',
    operation: 'edit',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'no_text',
    thumbnail: paperCollagePortraitThumbnail,
    variables: [
      { key: 'scene', multiline: true },
      { key: 'palette' },
      { key: 'details', multiline: true },
    ],
    styles: ['paper collage', 'portrait', 'editorial'],
    scenes: ['fashion', 'creative'],
    source: image2CaseSource(524),
  },
  {
    id: 'photo-doodle-mix',
    category: 'editing',
    operation: 'edit',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'no_text',
    thumbnail: photoDoodleMixThumbnail,
    variables: [
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['photo edit', 'doodle', 'mixed media'],
    scenes: ['travel', 'social'],
    source: image2CaseSource(530),
  },
  {
    id: 'doodle-character',
    category: 'character',
    operation: 'edit',
    defaultAspectRatio: '3:4',
    defaultTextMode: 'no_text',
    thumbnail: doodleCharacterThumbnail,
    variables: [
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['doodle', 'storybook', 'fashion sketch'],
    scenes: ['fashion', 'creative'],
    source: image2CaseSource(533),
  },
  {
    id: 'character-production-sheet',
    category: 'character',
    operation: 'edit',
    defaultAspectRatio: '16:9',
    defaultTextMode: 'baked_text',
    thumbnail: characterProductionSheetThumbnail,
    variables: [
      { key: 'details', multiline: true },
      { key: 'palette' },
    ],
    styles: ['character sheet', 'concept art', 'technical'],
    scenes: ['games', 'education'],
    source: image2CaseSource(512),
  },
] as const

export type BuildImagePromptInput = {
  aspectRatio: ImagePromptAspectRatio
  exactText?: string
  quality: 'low' | 'medium' | 'high'
  resolution: '1K' | '2K' | '4K'
  selectionText?: string
  templateId: ImagePromptTemplateId
  textMode: ImagePromptTextMode
  variables: Partial<ImagePromptVariableValues>
}

export function getImagePromptTemplate(templateId: ImagePromptTemplateId) {
  return IMAGE_PROMPT_TEMPLATES.find((template) => template.id === templateId)
    || IMAGE_PROMPT_TEMPLATES[0]
}

export function getRecommendedImagePromptTemplateIds(input: {
  hasReferenceImage: boolean
  hasSelectionText: boolean
}): readonly ImagePromptTemplateId[] {
  if (input.hasReferenceImage) {
    return [
      'mixed-media-memory-card',
      'travel-field-notes',
      'paper-collage-portrait',
      'photo-doodle-mix',
      'doodle-character',
      'character-production-sheet',
    ]
  }
  if (input.hasSelectionText) {
    return [
      'engineering-infographic',
      'brand-touchpoint-board',
      'surreal-city-poster',
      'editorial-silhouette-poster',
      'product-concept-board',
      'vocabulary-learning-card',
    ]
  }
  return [
    'surreal-city-poster',
    'miniature-product-campaign',
    'landmark-type-poster',
    'brand-touchpoint-board',
    'neon-creator-poster',
    'vintage-travel-poster',
  ]
}

export function filterImagePromptTemplates(input: {
  category?: ImagePromptTemplateCategoryFilter
  recommendedIds: readonly ImagePromptTemplateId[]
  view: ImagePromptTemplateView
}) {
  const recommended = new Set<ImagePromptTemplateId>(input.recommendedIds)
  return IMAGE_PROMPT_TEMPLATES.filter((template) => {
    if (input.view === 'recommended' && !recommended.has(template.id)) return false
    if (input.view === 'generate' && template.operation !== 'generate') return false
    if (input.view === 'edit' && template.operation !== 'edit') return false
    return !input.category
      || input.category === 'all'
      || template.category === input.category
  })
}

export function getMissingRequiredImagePromptVariables(
  template: ImagePromptTemplateDefinition,
  variables: Partial<ImagePromptVariableValues>,
) {
  return template.variables
    .filter((variable) => variable.required && !variables[variable.key]?.trim())
    .map((variable) => variable.key)
}

export function buildImagePrompt(input: BuildImagePromptInput) {
  const template = getImagePromptTemplate(input.templateId)
  const context = input.selectionText?.trim()
  const exactText = input.exactText?.trim()
  const variables = normalizeVariables(input.variables)
  const lines = [
    templateInstruction(template.id, variables),
  ]
  if (context) lines.push('', `Whiteboard context to incorporate when relevant: ${context}`)
  lines.push(
    '',
    `Output: one ${input.aspectRatio} image, ${input.resolution}, ${input.quality} quality.`,
  )
  if (input.textMode === 'editable_overlay') {
    lines.push(
      'Text policy: do not render readable words, letters, numerals, logos, signatures, or pseudo-text into the image. Preserve a clean, high-contrast text zone for a separate editable Kition text layer.',
    )
    if (exactText) lines.push(`Compose that empty text zone for this separate overlay copy: ${exactText}`)
  } else if (input.textMode === 'no_text') {
    lines.push('Text policy: include no words, letters, numerals, logos, signatures, watermarks, or pseudo-text.')
  } else if (exactText) {
    lines.push(`Required visible copy: render "${exactText}" accurately. Keep any other template-required labels minimal and do not invent unrelated wording.`)
  }
  lines.push(
    'Keep the composition coherent and production-focused. Avoid duplicated subjects, malformed details, unintended crops, unrelated props, watermarks, and decorative pseudo-writing.',
  )
  return lines.filter((line, index, all) => line || all[index - 1]).join('\n').trim()
}

function normalizeVariables(
  values: Partial<ImagePromptVariableValues>,
): ImagePromptVariableValues {
  return {
    subject: values.subject?.trim() || '',
    scene: values.scene?.trim() || '',
    details: values.details?.trim() || '',
    palette: values.palette?.trim() || '',
  }
}

function optionalLine(label: string, value: string) {
  return value ? `\n${label}: ${value}.` : ''
}

function templateInstruction(
  templateId: ImagePromptTemplateId,
  variables: ImagePromptVariableValues,
) {
  const subject = variables.subject || 'the selected reference subject'
  const scene = optionalLine('Scene direction', variables.scene)
  const details = optionalLine('Key details to preserve or include', variables.details)
  const palette = optionalLine('Color direction', variables.palette)
  switch (templateId) {
    case 'surreal-city-poster':
      return `Create a premium vertical editorial art poster about ${subject}. Build a dreamlike world where familiar daily life meets surreal monumental architecture, sculptural roads, oversized plants, tiny people, and one iconic focal point. Blend vintage travel-poster composition with modern luxury editorial design, tactile paper texture, subtle film grain, dramatic perspective, and generous negative space.${scene}${palette}`
    case 'miniature-product-campaign':
      return `Create a six-panel premium campaign for ${subject}. Use a strict two-column by three-row grid with consistent lighting and one continuous visual rhythm. Across the panels, show a recurring miniature person interacting with oversized product ingredients, materials, packaging, and the final hero product. Make the product system the visual hero, with physically believable scale, commercial material detail, and a clear escalating story from discovery to desire.${scene}${palette}`
    case 'engineering-infographic':
      return `Create a square, high-density engineering reference infographic about ${subject}. Place one accurate three-quarter hero render in the center, surrounded by modular technical callouts, dimensions, cutaways, system diagrams, specifications, lifecycle or performance comparisons, and a concise facts section. Use a premium editorial hierarchy, precise annotation lines, subtle blueprint overlays, rounded information modules, and breathable spacing.${details}${palette}`
    case 'landmark-type-poster':
      return `Create a clean typographic travel poster for ${subject}. Make the place name the main composition in large uppercase letters, then integrate accurate local landmarks, streets, transport, architecture, parks, waterfronts, and cultural details inside and around the letterforms while preserving legibility. Use crisp flat-vector geometry, restrained detail, generous negative space, and museum-quality editorial balance.${details}${palette}`
    case 'brand-touchpoint-board':
      return `Create a complete premium brand touchpoint board for ${subject}, not a single hero image. Include a realistic hero product scene plus a coordinated system of packaging, labels, cards, bags, digital touchpoints, secondary products, lifestyle crops, material details, and compact typography. Present it like a high-end design agency case-study board with consistent art direction and believable production finishes.${details}${palette}`
    case 'neon-creator-poster':
      return `Create a vertical premium 3D creator poster featuring ${subject} in a futuristic studio. Use a dramatic low-angle hero pose, oversized streetwear or role-appropriate styling, cinematic neon light, glossy reflections, floating tools and work objects, holographic interface fragments, and one collectible mini-figure variation. Keep the central silhouette strong and preserve a deliberate headline zone.${details}${palette}`
    case 'vintage-travel-poster':
      return `Create a cinematic vintage travel poster for ${subject}. Separate foreground, landmark-rich midground, and atmospheric background clearly. Use an iconic local silhouette, accurate architecture and cultural details, aged matte-paper texture, fine film grain, subtle halftone, restrained ink bleed, and a strong title area with clear sky or quiet negative space.${details}${palette}`
    case 'product-concept-board':
      return `Create a professional industrial-design concept board for ${subject}. Show inspiration analysis, morphology and crease or form mapping, iterative sketches, ergonomic translation, orthographic views, material studies, structural strategy, manufacturing notes, and a polished final hero render. Keep one coherent design logic from observation to prototype, with precise callouts and a quiet studio presentation.${details}${palette}`
    case 'vocabulary-learning-card':
      return `Create a clean, child-friendly vocabulary learning card about ${subject}. Show one large realistic whole object and one clearly related part, slice, segment, or component, connected by a playful dotted arrow and a tiny minimal character. Use short, accurate labels, rounded panels, bright spacing, soft daylight, and an uncluttered premium classroom aesthetic.${details}${palette}`
    case 'editorial-silhouette-poster':
      return `Create a high-contrast black-and-white editorial portrait poster featuring ${subject}. Build the side-profile portrait from bold silhouette blocks, sharp negative space, fragmented stencil shapes, rough ink edges, expressive calligraphic marks, and one dominant integrated text block. Use an off-white paper ground, asymmetric vertical layout, raw print texture, and a cropped fashion-editorial composition.${details}${palette}`
    case 'mixed-media-memory-card':
      return `Transform the authorized reference photo into a vertical mixed-media memory card with a strict 50/50 split. Keep the original photo unchanged in the top half. Use textured off-white handmade paper in the bottom half, then redraw the main subjects as a loose dark wax-crayon sketch over one irregular muted color patch. Preserve identity and the original moment while adding only subtle risograph grain and a quiet nostalgic mood.${details}${palette}`
    case 'travel-field-notes':
      return `Transform the authorized travel photo into a quiet 4:3 field-notes composition. Keep the photograph authentic on roughly 58% of the canvas and blend it naturally into aged handmade paper. On the paper side, reduce only the most recognizable location features into a small imperfect multi-color rubber-stamp print with generous blank space and understated archival notes. Preserve the original subject, perspective, light, terrain, architecture, and atmosphere.${details}${palette}`
    case 'paper-collage-portrait':
      return `Transform the authorized portrait into a premium handcrafted paper-collage diorama. Preserve the exact identity, pose, clothing, proportions, and natural skin texture of the person, while rebuilding the surrounding environment from layered cut paper, embossed botanical pieces, miniature scenery, visible fibers, soft folded shadows, and refined editorial depth. The real person remains the strongest focal point.${scene}${details}${palette}`
    case 'photo-doodle-mix':
      return `Transform only the people in the authorized reference photo into charming hand-drawn doodle characters while keeping the original photographic background unchanged. Preserve the sky, architecture, terrain, perspective, shadows, lighting, and all non-human objects. Match each person's identity, pose, clothing, accessories, scale, and location with loose ink lines, subtle crayon color, and believable contact shadows.${details}${palette}`
    case 'doodle-character':
      return `Transform the subject in the authorized reference image into a cute hand-drawn fashion doodle. Preserve recognizable facial features, face shape, hairstyle, clothing, accessories, and identity while simplifying the figure into an oversized head, small body, loose imperfect ink lines, scribbled hair, light cross-hatching, subtle blush, and restrained watercolor or crayon accents on an off-white background.${details}${palette}`
    case 'character-production-sheet':
      return `Use the authorized reference image as the primary design anchor for a premium 16:9 production character sheet. Preserve the silhouette, proportions, apparel layers, equipment count, materials, signature shapes, and color anchors across front, side, back, three-quarter, and action views. Add clean close-up callouts for materials, equipment, expressions, construction, and movement, with a large central hero and quiet technical grid.${details}${palette}`
  }
}
