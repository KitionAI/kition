import { expect, test, type Route } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  installDesignAgentFixture,
  readDesign,
} from './helpers/design'

test('generates an image into the artboard and keeps the headline editable', async ({
  page,
}) => {
  const requests: Array<Record<string, any>> = []
  await installDesignAgentFixture(page, ['agent_design_v1', 'agent_image_generation_v1'])
  await createDesign(page)
  // Registered after the workspace mock so these routes win.
  await page.route('**/workspace-files/Agent/**/*.png', (route) =>
    route.fulfill({
      contentType: 'image/webp',
      path: 'src/features/media-generation/assets/image-templates/engineering-infographic.webp',
    }),
  )
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, any>)
    await fulfillGeneratedImageStream(route)
  })

  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await expect(page.getByTestId('design-image-studio')).toBeVisible()
  await page.getByTestId('design-image-template-surreal-city-poster').click()
  await page
    .getByTestId('design-image-variable-subject')
    .fill('A calm launch city for a focused writing product')
  await page.getByTestId('design-image-exact-text').fill('LAUNCH WITH CLARITY')
  // The artboard is a 3:4 poster, so the studio starts from that ratio.
  await expect(page.getByTestId('design-image-advanced-settings')).toContainText('3:4')
  await page.getByTestId('design-image-generate').click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    pane_context: 'design',
    design_context: { design: { path: 'Untitled design.kidesign' } },
  })
  expect(requests[0].content).toContain('image_generation tool')
  expect(requests[0].content).toContain('Do not call design_propose_patch')

  await expect(page.getByTestId('design-image-add-0')).toBeVisible()
  await page.getByTestId('design-image-add-0').click()
  await expect(page.getByTestId('design-image-add-0')).toContainText('Added')
  // Placement decodes the artifact first, so wait for the layers to land.
  await expect
    .poll(async () => designLayers(await readDesign(page)).length)
    .toBe(2)
  await expectDesignSaved(page)
  const doc = await readDesign(page)
  const layers = designLayers(doc)
  expect(layers.map((layer) => layer.type)).toEqual(['image', 'text'])
  const [image, headline] = layers
  expect(doc.assets[image.assetId!].path).toBe('Agent/images/901/generated-launch.png')
  // Cover-fit: the image spans the artboard on at least one axis.
  expect(
    Math.round(image.width) === 1080 || Math.round(image.height) === 1440,
  ).toBe(true)
  expect(headline.text).toBe('LAUNCH WITH CLARITY')
  expect(headline.constraints).toEqual({ horizontal: 'center', vertical: 'center' })

  await page.getByTestId('design-image-studio-close').click()
  await page.locator(`[data-design-node="${headline.id}"]`).dblclick()
  await expect(
    page.getByRole('textbox', { name: 'Edit text', exact: true }),
  ).toHaveValue('LAUNCH WITH CLARITY')
})

async function fulfillGeneratedImageStream(route: Route) {
  const sessionId = Number(
    new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 701,
  )
  const now = '2026-09-29T00:00:00.000Z'
  const events = [
    {
      type: 'tool_call',
      tool_call: {
        id: 901,
        session_id: sessionId,
        user_id: 1,
        tool_name: 'image_generation',
        input_data: { prompt: 'Generate a launch visual' },
        output_data: { path: 'Agent/images/901/generated-launch.png', mime_type: 'image/png' },
        status: 'completed',
        created_at: now,
        updated_at: now,
      },
    },
    {
      type: 'done',
      done: true,
      extra_data: {
        session: {
          id: sessionId,
          user_id: 1,
          title: 'Design image generation',
          workspace_root: 'browser-local-workspace',
          active_document_path: 'Untitled design.kidesign',
          status: 'completed',
          created_at: now,
          updated_at: now,
        },
        message: {
          id: 911,
          session_id: sessionId,
          user_id: 1,
          role: 'assistant',
          content: 'Generated one image artifact for review.',
          status: 'completed',
          created_at: now,
        },
      },
    },
  ]
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}
