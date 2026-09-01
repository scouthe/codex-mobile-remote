import { homedir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const)

const APPROVAL_POLICIES = new Set([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
] as const)

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

type AppServerRuntimeConfig = {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  memories: boolean
}

/**
 * Unix socket exposed by the official Codex app-server used by codexapp.
 *
 * The value is deliberately kept separate from the normal runtime config:
 * codexapp connects through the official `proxy` command and does not pass
 * local sandbox/provider overrides to the Codex process.
 */
export const APP_SERVER_SOCKET_ENV_KEY = 'CODEXUI_APP_SERVER_SOCKET'
const DEFAULT_SHARED_APP_SERVER_SOCKET_RELATIVE_PATH = join(
  'app-server-control',
  'app-server-control.sock',
)

const DEFAULT_RUNTIME_CONFIG: AppServerRuntimeConfig = {
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  memories: true,
}

function normalizeRuntimeValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function readSandboxModeFromEnv(): CodexSandboxMode {
  const candidate = normalizeRuntimeValue(process.env.CODEXUI_SANDBOX_MODE)
  if (SANDBOX_MODES.has(candidate as CodexSandboxMode)) {
    return candidate as CodexSandboxMode
  }
  return DEFAULT_RUNTIME_CONFIG.sandboxMode
}

function readApprovalPolicyFromEnv(): CodexApprovalPolicy {
  const candidate = normalizeRuntimeValue(process.env.CODEXUI_APPROVAL_POLICY)
  if (APPROVAL_POLICIES.has(candidate as CodexApprovalPolicy)) {
    return candidate as CodexApprovalPolicy
  }
  return DEFAULT_RUNTIME_CONFIG.approvalPolicy
}

function readMemoriesFromEnv(): boolean {
  const candidate = normalizeRuntimeValue(process.env.CODEXUI_MEMORIES)
  if (candidate === 'false' || candidate === '0' || candidate === 'no') {
    return false
  }
  if (candidate === 'true' || candidate === '1' || candidate === 'yes') {
    return true
  }
  return DEFAULT_RUNTIME_CONFIG.memories
}

export function resolveAppServerRuntimeConfig(): AppServerRuntimeConfig {
  return {
    sandboxMode: readSandboxModeFromEnv(),
    approvalPolicy: readApprovalPolicyFromEnv(),
    memories: readMemoriesFromEnv(),
  }
}

export function resolveSharedAppServerSocket(): string | null {
  const configuredSocketPath = process.env[APP_SERVER_SOCKET_ENV_KEY]?.trim() ?? ''
  if (configuredSocketPath.length > 0) return configuredSocketPath

  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return join(codexHome, DEFAULT_SHARED_APP_SERVER_SOCKET_RELATIVE_PATH)
}

export function requireSharedAppServerSocket(): string {
  const socketPath = resolveSharedAppServerSocket()
  if (!socketPath) {
    throw new Error(
      `Shared Codex app-server socket is not configured. Set ${APP_SERVER_SOCKET_ENV_KEY} `
        + 'or pass --app-server-socket before starting codexapp.',
    )
  }
  return socketPath
}

/**
 * A configured Desktop socket is an architectural requirement, not a hint.
 * Falling back to a second app-server would split thread state and bring back
 * the writer-lock failures that shared mode is meant to prevent.
 */
export function assertSharedAppServerSocketAvailable(socketPath: string, available: boolean): void {
  const normalizedSocketPath = socketPath.trim()
  if (!normalizedSocketPath || available) return
  throw new Error(
    `Shared Codex app-server socket is unavailable: ${normalizedSocketPath}. `
      + 'Start or reconnect Codex Desktop, then retry the request.',
  )
}

export function buildAppServerProxyArgs(socketPath = resolveSharedAppServerSocket()): string[] | null {
  const normalizedSocketPath = socketPath?.trim() ?? ''
  if (!normalizedSocketPath) return null
  return ['app-server', 'proxy', '--sock', normalizedSocketPath]
}

/**
 * Runtime args for the short-lived account inspection process. The main
 * bridge never calls this function; it always uses the official shared proxy.
 */
export function buildAppServerArgs(): string[] {
  const config = resolveAppServerRuntimeConfig()
  return [
    'app-server',
    '-c',
    `approval_policy="${config.approvalPolicy}"`,
    '-c',
    `sandbox_mode="${config.sandboxMode}"`,
    '-c',
    `features.memories=${config.memories ? 'true' : 'false'}`,
  ]
}

export function parseSandboxMode(value: string): CodexSandboxMode | null {
  const candidate = value.trim().toLowerCase()
  return SANDBOX_MODES.has(candidate as CodexSandboxMode) ? candidate as CodexSandboxMode : null
}

export function parseApprovalPolicy(value: string): CodexApprovalPolicy | null {
  const candidate = value.trim().toLowerCase()
  return APPROVAL_POLICIES.has(candidate as CodexApprovalPolicy) ? candidate as CodexApprovalPolicy : null
}
