import { getDesktopBridge } from '@/services/desktopClient/bridge'

/**
 * How Kition prints a PDF a kit hands over (KitFiles `files/print`, capability `print`): the
 * desktop shell prints it with the system's print dialog (`print_pdf`) and answers whether the
 * person printed. Without the shell Kition offers kits no printing: its page may not show a PDF in
 * a frame (its policy has `object-src 'none'`, which a PDF viewer needs).
 */
export function kitionPrint(): ((job: { bytes: Uint8Array; title: string }) => Promise<boolean>) | undefined {
  const bridge = getDesktopBridge()
  return bridge?.PrintPdf ? (job) => bridge.PrintPdf!(job.bytes, job.title) : undefined
}
