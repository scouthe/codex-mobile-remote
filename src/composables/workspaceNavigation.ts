export type WorkspaceTool = 'codex' | 'dsh'
const key = (tool: WorkspaceTool) => `codex-remote.workspace.${tool}.last-route`
export function rememberWorkspaceRoute(tool: WorkspaceTool, path: string): void {
  try { localStorage.setItem(key(tool), tool === 'dsh' ? '/dsh' : path) } catch { /* private browsing */ }
}
export function workspaceRoute(tool: WorkspaceTool): string {
  if (tool === 'dsh') return '/dsh'
  const fallback = '/'
  try {
    const path = localStorage.getItem(key(tool)) || fallback
    return /^\/(?:thread\/[^/?#]+|skills|automations|phone-agent)?(?:\?|$)/.test(path) ? path : fallback
  } catch { return fallback }
}
