import type { UiLiveOverlay, UiMessage } from '../types/codex'

/**
 * Keep the mobile conversation focused on messages a user can read or act on.
 * Runtime details remain available on desktop and in the task timeline.
 */
export function shouldRenderConversationMessage(message: UiMessage, isMobile: boolean): boolean {
  if (!isMobile) return true

  // Keep command and file-change rows available as compact, expandable
  // controls on mobile. They contain useful output and undo/redo actions;
  // only the decorative "worked" separators are redundant with the timeline.
  return message.messageType !== 'worked'
}

/** Keep actionable live errors visible while removing the duplicate activity
 * line that is already represented by the mobile task status bar. */
export function shouldRenderLiveOverlay(overlay: UiLiveOverlay | null, isMobile: boolean): boolean {
  if (!overlay) return false
  return !isMobile || overlay.errorText.trim().length > 0
}
