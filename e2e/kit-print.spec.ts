import { expect, test, type Page } from '@playwright/test'
import { keepKitChannels, noteGesture as gesture, requestFromNote as fromKit } from './helpers/kitChannel'
import { openNote } from './helpers/noteKit'

/**
 * Kition prints a PDF a kit hands over (KitFiles `files/print`, capability `print`): the Note
 * kit's manifest may print. On every platform the desktop shell prints it with the system's print
 * dialog (`print_pdf`: PDFKit on macOS, GTK on Linux, Windows.Data.Pdf and `PrintDlgEx` on
 * Windows), which the desktop host records here; the dialogs themselves are checked by hand in the
 * desktop app. A kit whose manifest does not ask to print is offered no printing.
 */
test.setTimeout(180_000)

const PDF = '%PDF-1.7\n% e2e print\n%%EOF\n'

/** Whether the kit was offered printing: the capabilities Kition listed in its handshake. */
async function offered(page: Page) {
  const frame = page.frames().find((candidate) => candidate.url().includes('/kits/note-ui/'))
  return frame!.evaluate(() => (window as unknown as { __e2eKitCapabilities?: string[] }).__e2eKitCapabilities ?? [])
}

/** Keeps the capabilities Kition lists in `ui/initialize`, as the kit sees them. */
async function keepCapabilities(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const port = (event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 ? event.ports[0] : undefined
      port?.addEventListener('message', (message: MessageEvent) => {
        const capabilities = message.data?.result?.capabilities ?? message.data?.params?.capabilities
        if (Array.isArray(capabilities)) (window as unknown as { __e2eKitCapabilities?: string[] }).__e2eKitCapabilities = capabilities
      })
    })
  })
}

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`on ${platform} a kit’s PDF prints with the system’s print dialog, which answers whether the person printed`, async ({ page, baseURL }) => {
    await keepKitChannels(page)
    const { kit, host } = await openNote(page, baseURL!, 'Plan.md', '# Plan\n\nGoals.\n', {}, { desktop: { platform } })

    await gesture(kit)
    const printed = await fromKit(page, 'files/print', { mime: 'application/pdf', title: 'Plan' }, PDF)
    expect(printed.error).toBeUndefined()
    expect(printed.result).toEqual({ printed: true })
    expect(host.prints).toHaveLength(1)
    expect(host.prints[0].title).toBe('Plan')
    expect(host.prints[0].bytes.toString('utf8')).toBe(PDF)

    // The person cancels the dialog: nothing printed, and the kit learns no more than that (FA11).
    host.printAnswer = false
    await gesture(kit)
    expect((await fromKit(page, 'files/print', { mime: 'application/pdf', title: 'Plan' }, PDF)).result).toEqual({ printed: false })

    // Only a PDF prints.
    await gesture(kit)
    expect((await fromKit(page, 'files/print', { mime: 'text/html', title: 'Plan' }, '<p>x</p>')).error?.code).toBe(-32602)
    expect(host.prints).toHaveLength(2)
  })
}

test('a kit whose manifest does not ask to print is offered no printing', async ({ page, baseURL }) => {
  await keepKitChannels(page)
  await keepCapabilities(page)
  await page.route('**/kits/note-ui/kit.json', async (route) => {
    const manifest = await (await route.fetch()).json()
    await route.fulfill({ json: { ...manifest, files: { ...manifest.files, print: false } } })
  })
  const { kit, host } = await openNote(page, baseURL!, 'Plan.md', '# Plan\n\nGoals.\n')

  expect(await offered(page)).toContain('files')
  expect(await offered(page)).not.toContain('print')
  await gesture(kit)
  expect((await fromKit(page, 'files/print', { mime: 'application/pdf', title: 'Plan' }, PDF)).error?.data?.reason).toBe('unsupported')
  expect(host.prints).toHaveLength(0)
})
