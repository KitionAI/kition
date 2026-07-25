   
            
  
                         
                                
                                                
  
            
   

import { EditorView } from '@codemirror/view'

import { importWorkspaceImageFromBlobURL } from '@/services/desktop'

const ATTACHMENT_FOLDER = 'Attachments'

function isImageItem(item: DataTransferItem): boolean {
  return item.kind === 'file' && item.type.startsWith('image/')
}

export function pasteImageExtension() {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData
      if (!data) return false
      const imageItems = Array.from(data.items).filter(isImageItem)
      if (imageItems.length === 0) return false
                                                
      const text = data.getData('text/plain')
      if (text && /^https?:\/\//.test(text.trim()) && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(text.trim())) {
        return false
      }
      event.preventDefault()
      const files = imageItems
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length === 0) return false
      void (async () => {
        const inserts: string[] = []
        let idx = 1
        for (const file of files) {
          try {
            const url = URL.createObjectURL(file)
            const { relativePath } = await importWorkspaceImageFromBlobURL({
              folder: ATTACHMENT_FOLDER,
              blobURL: url,
              index: idx++,
            })
            URL.revokeObjectURL(url)
            const name = relativePath.split('/').pop() ?? relativePath
            inserts.push(`![[${ATTACHMENT_FOLDER}/${name}]]`)
          } catch (e) {
            console.warn('paste-image: import failed', e)
          }
        }
        if (inserts.length === 0) return
        const sel = view.state.selection.main
        const insertText = inserts.join('\n')
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: insertText },
          selection: { anchor: sel.from + insertText.length },
          userEvent: 'input.paste',
        })
      })()
      return true
    },
  })
}
