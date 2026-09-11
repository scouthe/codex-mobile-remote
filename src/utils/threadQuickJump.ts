/** Return true for the conventional Ctrl/Cmd+K quick-thread shortcut. */
export function isThreadQuickJumpShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return event.key.toLowerCase() === 'k'
    && (event.ctrlKey || event.metaKey)
    && !event.shiftKey
    && !event.altKey
}
