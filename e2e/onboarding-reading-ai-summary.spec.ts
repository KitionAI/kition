import { expect, test } from '@playwright/test'

import { openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'
import { configureModel, mockGenerate, onboardingTable, promptText, recordCount, recordMenu, savedTables, serveKitTables } from './helpers/tableAi'

/**
 * AI-SCENE-004 (docs/kition-onboarding-core-scenarios.csv): in the onboarding Reading Tracker,
 * the person asks for one row's AI Summary. The field never runs on its own (auto_update is off);
 * the run sends one model request for that row; the summary is saved in that cell only and a
 * rerun replaces it; a model that times out leaves the previous summary and can be retried.
 */
test('AI-SCENE-004: the Reading Tracker summarizes the asked row once, keeps the rest, and survives a timeout', async ({ page, baseURL, browserName }) => {
  test.setTimeout(180_000)
  const bytes = await onboardingTable('ReadingTracker.ktable')
  const before = await savedTables(bytes)
  const [first, second] = before['Reading List']
  await configureModel(page)

  let requests: Array<Record<string, any>> = []
  const routes = async (page: import('@playwright/test').Page) => {
    await serveKitTables(page)
    requests = await mockGenerate(page, [
      { text: 'Kition fills AI fields from a row. You decide when each one runs.' },
      { text: 'AI fields run when you ask. The source row stays as it was.' },
      { refuse: 'timeout', message: 'The model took too long to answer.' },
      { text: 'A retried summary replaces the cell once.' },
    ])
  }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Reading Tracker.ktable', bytes, {}, { routes })
  try {
    await expect(recordCount(kit)).toContainText('2 records', { timeout: 60_000 })
    // Nothing runs before the person asks: the AI Summary field has auto_update off.
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0)
    expect(requests).toHaveLength(0)

    await recordMenu(kit, 0)
    await kit.getByRole('button', { name: 'Regenerate AI fields' }).click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1)
    expect(requests[0]).toMatchObject({ purpose: 'ai-field', output: 'text', runtimeModel: expect.objectContaining({ model_name: 'gpt-test' }) })
    const prompt = promptText(requests[0])
    expect(prompt).toContain('Summarize the linked article in 2-3 sentences')
    expect(prompt).toContain(String(first.values.title))
    expect(prompt).not.toContain(String(second.values.title))

    // A rerun replaces the cell once rather than appending to it.
    await recordMenu(kit, 0)
    await kit.getByRole('button', { name: 'Regenerate AI fields' }).click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2)

    // A model that times out says so and leaves the summary it had.
    await recordMenu(kit, 0)
    await kit.getByRole('button', { name: 'Regenerate AI fields' }).click()
    await expect(kit.getByText(/took too long to answer/)).toBeVisible({ timeout: 30_000 })
    expect(requests).toHaveLength(3)

    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    if (canReadBlobBodies(browserName)) {
      const saved = (await savedTables(saves.at(-1)!.bytes))['Reading List']
      const asked = saved.find((record) => record.id === first.id)!
      expect(asked.values.ai_summary).toBe('AI fields run when you ask. The source row stays as it was.')
      expect(asked.values).toMatchObject({ title: first.values.title, url: first.values.url, status: first.values.status })
      expect(saved.find((record) => record.id === second.id)?.values).toEqual(second.values)
    }

    // The cell can be retried after the timeout.
    await recordMenu(kit, 0)
    await kit.getByRole('button', { name: 'Regenerate AI fields' }).click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(4)
    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    if (canReadBlobBodies(browserName)) {
      const saved = (await savedTables(saves.at(-1)!.bytes))['Reading List']
      expect(saved.find((record) => record.id === first.id)?.values.ai_summary).toBe('A retried summary replaces the cell once.')
    }
  } finally {
    await host.dispose()
  }
})
