### Shared app-server socket fails closed during Desktop reconnect

#### Prerequisites
- A built checkout (`pnpm run build`).
- A Unix socket path that is not present for the isolated test instance.
- A running Codex Desktop-owned app-server socket for the recovery check.

#### Steps
1. Start an isolated instance on a disposable port with `CODEX_HOME` set to a temporary home that has no app-server socket, without `--app-server-socket`.
2. Query `/codex-api/app-server/status` and post a read-only RPC to `/codex-api/rpc`.
3. Confirm the status reports the deterministic default path with `mode: "shared-proxy"`, `running: false`, and `socketAvailable: false`; confirm the RPC explains that the shared socket is unavailable.
4. Confirm the isolated process has not spawned a `codex app-server` child.
5. Stop the isolated instance, point a new disposable instance at the real Desktop socket, and query `thread/list`.

#### Expected Results
- A configured but unavailable shared socket never falls back to a second standalone app-server.
- The main bridge uses the official default socket path when no override is provided.
- The web process remains available for diagnostics and retries successfully once the Desktop socket is available again.
- The recovery instance uses `codex app-server proxy --sock` and can read existing threads.

#### Rollback/Cleanup
- Stop both disposable test instances and leave the Desktop app-server and its socket untouched.
