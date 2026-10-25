export type WorkspaceTool = 'codex' | 'dsh'
const key = (tool: WorkspaceTool) => `codex-remote.workspace.${tool}.last-route`
export function rememberWorkspaceRoute(tool: WorkspaceTool, path: string): void {
  try { localStorage.setItem(key(tool), path) } catch { /* private browsing */ }
}
export function workspaceRoute(tool: WorkspaceTool): string {
  const fallback = tool === 'codex' ? '/' : '/dsh'
  try {
    const path = localStorage.getItem(key(tool)) || fallback
    return tool === 'dsh' ? /^\/dsh(?:\/|$)/.test(path) ? path : fallback : /^\/(?:thread\/[^/?#]+|skills|automations)?(?:\?|$)/.test(path) ? path : fallback
  } catch { return fallback }
}
