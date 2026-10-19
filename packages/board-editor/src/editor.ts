/**
 * `@kition/board-editor/editor`: the board editor: its canvas, toolbars, panels, and the
 * controller hook that owns the board's `BoardStore`. Its root needs a `BoardHostProvider` (every
 * member optional) and react-i18next with the `workspace` and `imageGeneration` namespaces.
 */
import './components/whiteboard.css'

export { WhiteboardAgentPreviewControls } from './components/WhiteboardAgentPreview'
export { WhiteboardAgentScopeControl } from './components/WhiteboardAgentScopeControl'
export { WhiteboardCanvas } from './components/WhiteboardCanvas'
export { WhiteboardMinimap } from './components/WhiteboardMinimap'
export { WhiteboardSelectionToolbar } from './components/WhiteboardSelectionToolbar'
export { WhiteboardStylePanel } from './components/WhiteboardStylePanel'
export { WhiteboardTemplatePreview } from './components/WhiteboardTemplateGallery'
export { WhiteboardToolbar } from './components/WhiteboardToolbar'
export { WhiteboardTopActions } from './components/WhiteboardTopActions'
export { useWhiteboardAgentPatch } from './hooks/useWhiteboardAgentPatch'
export { useWhiteboardEditor } from './hooks/useWhiteboardEditor'
export { buildWhiteboardAgentContext, type WhiteboardAgentScope } from './lib/whiteboardAgentContext'
export {
  buildEditableImageTextOverlay,
  getEditableImageTextOverlay,
  getGeneratedImageCenters,
  getGeneratedImagePlacementSize,
} from './lib/whiteboardGeneratedImages'
