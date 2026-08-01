import type { TFunction } from 'i18next'

import type {
  KitableTemplateAssetReference,
  KitableTemplateSeed,
  KitableTemplateViewFieldLayout,
} from './kitableTemplates'

const CONTENT_TYPES = [
  'Gaming',
  'Entertainment & Challenges',
  'How-to & Education',
  'Tech & Reviews',
  'Lifestyle & Vlog',
  'News & Commentary',
  'Business & Finance',
  'Health & Fitness',
]

const CORE_EMOTIONS = [
  'Confident',
  'Curious',
  'Excited',
  'Shock',
  'Urgent',
  'Mysterious',
  'Funny',
  'Serious',
  'Angry',
  'Winning',
  'Relax',
]

const THUMBNAIL_LAYOUTS = [
  'Auto',
  'Center Face + Big Title',
  'Left Face / Right Title',
  'Right Face / Left Title',
  'Face + Object/Screen Callout',
  'Before vs After Split',
  'Face Over Blurred Background',
]

const HOOK_STRENGTH_DESCRIPTION = `Choose how strongly the composition calls attention to one key detail.

- Auto: match the story and layout.
- Off: clean composition with no callout effects.
- Low: one restrained outline, glow, arrow, or circle.
- High: one bold callout with stronger contrast and impact.`

const YOUTUBE_TITLE_PROMPT = `Create one original thumbnail title for a YouTube video.

Story: {{Key Message}}
Category: {{Content Type}}
Desired emotion: {{Core Emotion}}

Write a concrete, outcome-focused phrase that communicates the story at a glance. Use 3 to 6 words, with a maximum of 8. Keep one idea, use no hashtags or emojis, and avoid vague clickbait. Return only the title.`

const TIKTOK_TITLE_PROMPT = `Create one original cover title for a TikTok video.

Story: {{Key Message}}
Category: {{Content Type}}
Desired emotion: {{Core Emotion}}

Write a compact hook plus keyword label that remains readable in a profile grid. Use 2 to 4 words, with a maximum of 6. Keep one idea and use no hashtags, emojis, quotes, or filler. Return only the title.`

const YOUTUBE_IMAGE_PROMPT = `Create an original, photorealistic YouTube thumbnail in a wide 16:9 composition.

Story: {{Key Message}}
Exact title: {{Thumbnail Title (16:9)}}
Category: {{Content Type}}
Emotion: {{Core Emotion}}
Layout: {{Thumbnail Layout}}
Hook strength: {{Hook Strength}}

Identity is mandatory: use the attached Face Photo as the only identity reference. Preserve the same recognizable person, facial structure, age, skin tone, hair, and gender presentation. Do not replace the person with a generic model, celebrity, illustration, avatar, or lookalike.

Place the person in a believable scene that explains the story immediately. Keep the face large, natural, sharply focused, and separate from the title. Render the exact title once in bold condensed sans-serif lettering inside safe margins. Use strong mobile readability, natural cinematic lighting, one topic-specific object or environmental cue, and minimal clutter. Follow the selected layout and hook strength. No logos, watermarks, UI chrome, template variables, or extra text. Return only the finished thumbnail.`

const TIKTOK_IMAGE_PROMPT = `Create an original, photorealistic TikTok cover in a vertical 9:16 composition.

Story: {{Key Message}}
Exact title: {{Thumbnail Title (9:16)}}
Category: {{Content Type}}
Emotion: {{Core Emotion}}
Layout: {{Thumbnail Layout}}
Hook strength: {{Hook Strength}}

Identity is mandatory: use the attached Face Photo as the only identity reference. Preserve the same recognizable person, facial structure, age, skin tone, hair, and gender presentation. Do not replace the person with a generic model, celebrity, illustration, avatar, or lookalike.

Place the person in a believable scene that explains the story immediately. Keep the face large and sharply focused in the upper half. Render the exact title once in a compact bold condensed sans-serif block inside the central mobile-safe area, away from the right and bottom interface zones. Use natural cinematic lighting, one topic-specific object or environmental cue, strong separation, and minimal clutter. Follow the selected layout and hook strength. No logos, watermarks, UI chrome, template variables, or extra text. Return only the finished cover.`

const assetReferences = (...assetIds: string[]): KitableTemplateAssetReference => ({ assetIds })

const quickStartLayouts: KitableTemplateViewFieldLayout[] = [
  { fieldTitle: 'Key Message', position: 0, width: 260, frozen: true },
  { fieldTitle: 'Face Photo', position: 1, width: 220 },
  { fieldTitle: 'Content Type', position: 2, width: 200 },
  { fieldTitle: 'Core Emotion', position: 3, width: 150 },
  { fieldTitle: 'Thumbnail Title (16:9)', position: 4, width: 220, visible: false },
  { fieldTitle: 'Thumbnail Title (9:16)', position: 5, width: 210, visible: false },
  { fieldTitle: 'Thumbnail (16:9)', position: 6, width: 520 },
  { fieldTitle: 'Thumbnail (9:16)', position: 7, width: 240 },
  { fieldTitle: 'Thumbnail Layout', position: 8, width: 210, visible: false },
  { fieldTitle: 'Hook Strength', position: 9, width: 150, visible: false },
]

const advancedLayouts: KitableTemplateViewFieldLayout[] = [
  { fieldTitle: 'Key Message', position: 0, width: 220, frozen: true },
  { fieldTitle: 'Face Photo', position: 1, width: 210 },
  { fieldTitle: 'Content Type', position: 2, width: 190 },
  { fieldTitle: 'Core Emotion', position: 3, width: 150 },
  { fieldTitle: 'Thumbnail Title (16:9)', position: 4, width: 220 },
  { fieldTitle: 'Thumbnail Title (9:16)', position: 5, width: 210 },
  { fieldTitle: 'Thumbnail Layout', position: 6, width: 210 },
  { fieldTitle: 'Hook Strength', position: 7, width: 150 },
  { fieldTitle: 'Thumbnail (16:9)', position: 8, width: 480 },
  { fieldTitle: 'Thumbnail (9:16)', position: 9, width: 260 },
]

export function createThumbnailGeneratorTemplate(
  t: TFunction<'table'>,
): KitableTemplateSeed {
  return {
    id: 'thumbnail-generator',
    title: t('templateLibrary.templates.thumbnailGenerator.title'),
    description: t('templateLibrary.templates.thumbnailGenerator.description'),
    documentDescription: 'Create original YouTube thumbnails and TikTok covers from a portrait and a structured story brief.',
    usageCount: 0,
    icon: 'image',
    color: 'rose',
    assetManifestPath: '/templates/youtube-tiktok-thumbnail-generator/manifest.json',
    tables: [{
      title: 'Video Thumbnail Studio',
      description: 'Original landscape thumbnails and vertical covers built around a consistent creator identity.',
      fields: [
        {
          title: 'Key Message',
          name: 'key_message',
          type: 'long_text',
          primary: true,
          required: true,
          options: { description: 'Describe the specific story the video delivers.' },
        },
        {
          title: 'Face Photo',
          name: 'face_photo',
          type: 'attachment',
          required: true,
          options: { description: 'Upload one clear portrait. Generated images must preserve this identity.' },
        },
        {
          title: 'Content Type',
          name: 'content_type',
          type: 'single_select',
          required: true,
          options: {
            choices: CONTENT_TYPES,
            description: 'Choose the category that best matches the video.',
          },
        },
        {
          title: 'Core Emotion',
          name: 'core_emotion',
          type: 'single_select',
          required: true,
          options: {
            choices: CORE_EMOTIONS,
            description: 'Choose the main emotion the image should communicate.',
          },
        },
        {
          title: 'Thumbnail Title (16:9)',
          name: 'thumbnail_title_16_9',
          type: 'long_text',
          options: { description: 'Short title generated for the landscape thumbnail.' },
          aiConfig: {
            type: 'customize',
            prompt: YOUTUBE_TITLE_PROMPT,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Thumbnail Title (9:16)',
          name: 'thumbnail_title_9_16',
          type: 'long_text',
          options: { description: 'Compact title generated for the vertical cover.' },
          aiConfig: {
            type: 'customize',
            prompt: TIKTOK_TITLE_PROMPT,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Thumbnail Layout',
          name: 'thumbnail_layout',
          type: 'single_select',
          options: {
            choices: THUMBNAIL_LAYOUTS,
            defaultValue: 'Auto',
            preventAutoNewOptions: false,
            description: 'Choose how the portrait, title, and story object share the frame.',
          },
        },
        {
          title: 'Hook Strength',
          name: 'hook_strength',
          type: 'single_select',
          options: {
            choices: ['Auto', 'Off', 'Low', 'High'],
            defaultValue: 'Auto',
            description: HOOK_STRENGTH_DESCRIPTION,
          },
        },
        {
          title: 'Thumbnail (16:9)',
          name: 'thumbnail_16_9',
          type: 'attachment',
          options: { description: 'Two landscape variants generated from the portrait and brief.' },
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Face Photo',
            prompt: YOUTUBE_IMAGE_PROMPT,
            enabled: true,
            auto_update: true,
            n: 2,
            quality: 'high',
            aspect_ratio: '16:9',
            resolution: '1K',
            image_use_case: 'cover_illustration',
          },
        },
        {
          title: 'Thumbnail (9:16)',
          name: 'thumbnail_9_16',
          type: 'attachment',
          options: { description: 'Two vertical variants generated from the portrait and brief.' },
          aiConfig: {
            type: 'image_customization',
            sourceFieldTitle: 'Face Photo',
            prompt: TIKTOK_IMAGE_PROMPT,
            enabled: true,
            auto_update: true,
            n: 2,
            quality: 'high',
            aspect_ratio: '9:16',
            resolution: '1K',
            image_use_case: 'cover_illustration',
          },
        },
      ],
      views: [
        {
          title: 'Quick Start',
          type: 'grid',
          config: { row_height: 'extra_tall', frozen_column_count: 1 },
          hiddenFieldTitles: [
            'Thumbnail Title (16:9)',
            'Thumbnail Title (9:16)',
            'Thumbnail Layout',
            'Hook Strength',
          ],
          fieldLayouts: quickStartLayouts,
        },
        {
          title: 'Advanced',
          type: 'grid',
          config: { row_height: 'extra_tall', frozen_column_count: 1 },
          fieldLayouts: advancedLayouts,
        },
      ],
      records: [
        {
          'Key Message': 'I built a silent recording studio inside a closet',
          'Face Photo': assetReferences('record-01-face-photo-01'),
          'Content Type': 'How-to & Education',
          'Core Emotion': 'Curious',
          'Thumbnail Title (16:9)': 'A Studio in a Closet',
          'Thumbnail Title (9:16)': 'Closet Studio Build',
          'Thumbnail Layout': 'Left Face / Right Title',
          'Hook Strength': 'Low',
          'Thumbnail (16:9)': assetReferences('record-01-thumbnail-16x9-01', 'record-01-thumbnail-16x9-02'),
          'Thumbnail (9:16)': assetReferences('record-01-thumbnail-9x16-01', 'record-01-thumbnail-9x16-02'),
        },
        {
          'Key Message': 'Can a thirty-dollar solar panel power my entire desk?',
          'Face Photo': assetReferences('record-02-face-photo-01'),
          'Content Type': 'Tech & Reviews',
          'Core Emotion': 'Shock',
          'Thumbnail Title (16:9)': '$30 Solar Desk Test',
          'Thumbnail Title (9:16)': '$30 Solar Test',
          'Thumbnail Layout': 'Face + Object/Screen Callout',
          'Hook Strength': 'High',
          'Thumbnail (16:9)': assetReferences('record-02-thumbnail-16x9-01', 'record-02-thumbnail-16x9-02'),
          'Thumbnail (9:16)': assetReferences('record-02-thumbnail-9x16-01', 'record-02-thumbnail-9x16-02'),
        },
        {
          'Key Message': 'I cooked five dinners from one tiny balcony harvest',
          'Face Photo': assetReferences('record-03-face-photo-01'),
          'Content Type': 'Lifestyle & Vlog',
          'Core Emotion': 'Excited',
          'Thumbnail Title (16:9)': '5 Dinners, One Balcony',
          'Thumbnail Title (9:16)': 'Balcony Harvest Meals',
          'Thumbnail Layout': 'Right Face / Left Title',
          'Hook Strength': 'Low',
          'Thumbnail (16:9)': assetReferences('record-03-thumbnail-16x9-01', 'record-03-thumbnail-16x9-02'),
          'Thumbnail (9:16)': assetReferences('record-03-thumbnail-9x16-01', 'record-03-thumbnail-9x16-02'),
        },
        {
          'Key Message': 'I trained my rescue dog to ring the doorbell',
          'Face Photo': assetReferences('record-04-face-photo-01'),
          'Content Type': 'How-to & Education',
          'Core Emotion': 'Winning',
          'Thumbnail Title (16:9)': 'Doorbell Training Worked',
          'Thumbnail Title (9:16)': 'Dog Rings Doorbell',
          'Thumbnail Layout': 'Face + Object/Screen Callout',
          'Hook Strength': 'Auto',
          'Thumbnail (16:9)': assetReferences('record-04-thumbnail-16x9-01', 'record-04-thumbnail-16x9-02'),
          'Thumbnail (9:16)': assetReferences('record-04-thumbnail-9x16-01', 'record-04-thumbnail-9x16-02'),
        },
        {
          'Key Message': 'I mapped every hidden stairway in my city',
          'Face Photo': assetReferences('record-05-face-photo-01'),
          'Content Type': 'Entertainment & Challenges',
          'Core Emotion': 'Mysterious',
          'Thumbnail Title (16:9)': 'Hidden Stairs Nobody Sees',
          'Thumbnail Title (9:16)': 'Secret City Stairs',
          'Thumbnail Layout': 'Face Over Blurred Background',
          'Hook Strength': 'Low',
          'Thumbnail (16:9)': assetReferences('record-05-thumbnail-16x9-01', 'record-05-thumbnail-16x9-02'),
          'Thumbnail (9:16)': assetReferences('record-05-thumbnail-9x16-01', 'record-05-thumbnail-9x16-02'),
        },
      ],
    }],
  }
}
