### Codex app-server memories default and opt-out

#### Feature/Change Name
Temporary account-refresh app-server starts with memories enabled by default
and supports `--no-memories`. The main bridge always uses the shared official
Codex app-server proxy.

#### Prerequisites/Setup
1. Build the CLI: `pnpm run build:cli`.
2. Use a temporary Codex home that does not already enable memories, for example `CODEX_HOME=$(mktemp -d)`.

#### Steps
1. Run the unit test: `pnpm exec vitest run src/server/appServerRuntimeConfig.test.ts`.
2. Start the packaged CLI in light theme with the temporary Codex home and configured shared socket: `CODEX_HOME=<temp-home> node dist-cli/index.js --no-open --no-tunnel --no-login --no-password --port 5900 --app-server-socket <official-socket>`.
3. Trigger an account inspection/refresh route, which starts the isolated account-refresh app-server.
4. Confirm the spawned app-server command includes `-c features.memories=true`, or confirm `codex features list` with equivalent config reports `memories` enabled.
5. Stop the temporary CLI process.
6. Start the packaged CLI with opt-out: `CODEX_HOME=<temp-home> node dist-cli/index.js --no-open --no-tunnel --no-login --no-password --no-memories --port 5900 --app-server-socket <official-socket>`.
7. Trigger the account inspection/refresh route again.
8. Confirm the spawned app-server command includes `-c features.memories=false`.
9. Open `http://127.0.0.1:5900/#/` and confirm the app shell still renders normally in light theme.
10. Switch to dark theme and confirm the app shell still renders normally.

#### Expected Results
- `buildAppServerArgs()` includes `-c features.memories=true`.
- `CODEXUI_MEMORIES=false` and `--no-memories` produce `-c features.memories=false`.
- The temporary account-refresh process no longer depends on the user's `~/.codex/config.toml` to enable memories.
- Light and dark themes are unchanged because this is a runtime launch/config change, not a UI surface change.

#### Rollback/Cleanup
- Stop the temporary packaged CLI process.
- Remove the temporary `CODEX_HOME`.

---
