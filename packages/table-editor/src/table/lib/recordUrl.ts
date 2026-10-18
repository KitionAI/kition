export function buildRecordDeepLink(documentId: number, tableId: number, rowKey: string): string {
  return `kition://doc/${documentId}/table/${tableId}/record/${encodeURIComponent(rowKey)}`
}
