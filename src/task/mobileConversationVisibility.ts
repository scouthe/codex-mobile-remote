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

/** The task status bar already shows activity on both layouts; keep only actionable errors here. */
export function shouldRenderLiveOverlay(overlay: UiLiveOverlay | null, _isMobile: boolean): boolean {
  return Boolean(overlay?.errorText.trim())
}
