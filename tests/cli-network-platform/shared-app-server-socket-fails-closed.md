### Shared app-server socket bootstraps the official app-server

#### Prerequisites
- A built checkout (`pnpm run build`).
- A Unix socket path that is not present for the isolated test instance.
- The official Codex CLI available on `PATH`.

#### Steps
1. Start an isolated instance on a disposable port with `CODEX_HOME` set to a temporary home that has no app-server socket, without `--app-server-socket`.
2. Query `/codex-api/app-server/status` and post a read-only RPC to `/codex-api/rpc`.
3. Confirm the first RPC starts exactly one official `codex app-server --listen unix://` process, waits for the standard socket, and then uses `codex app-server proxy --sock`.
4. Confirm a second concurrent RPC does not start another official app-server process.
5. Stop the isolated instance, start it again with the same `CODEX_HOME`, and confirm it reuses the existing official socket without spawning another app-server.

#### Expected Results
- A configured but unavailable shared socket bootstraps the official app-server once.
- The main bridge uses the official default socket path when no override is provided.
- The web process remains available for diagnostics if official startup fails.
- The bridge uses `codex app-server proxy --sock` and can read existing threads.

#### Rollback/Cleanup
- Stop both disposable test instances and leave the Desktop app-server and its socket untouched.
