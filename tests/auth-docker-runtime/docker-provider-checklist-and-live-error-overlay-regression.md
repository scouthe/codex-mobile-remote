### Docker provider checklist and live error overlay regression

#### Feature/Change Name
Docker provider/auth checklist execution and live error overlay de-duplication.

#### Prerequisites/Setup
1. Run `pnpm run build`.
2. Run `pnpm pack --pack-destination /tmp`.
3. Build a Docker image from the packed `codexapp` tarball with `@openai/codex` installed.
4. Start three isolated containers:
   - no auth file
   - invalid or expired `auth.json`
   - malformed `auth.json`

#### Steps
1. In light theme, open the no-auth container, confirm the composer starts on `big-pickle`, send `hi`, and wait for an assistant reply.
2. Switch the Settings provider selector to OpenRouter, send `hi` again, and wait for a reply or provider-scoped response.
3. Open the invalid-auth container, send `hi`, wait for the final 401/auth error, and confirm `Send feedback` is visible.
4. Reload the invalid-auth thread and confirm the persisted error remains without a duplicate live `Thinking` error overlay.
5. Switch the invalid-auth thread to dark theme and confirm the persisted error and feedback button remain readable.
6. Open the malformed-auth container, confirm it falls back to `big-pickle`, send `hi`, and wait for an assistant reply.

#### Expected Results
- No-auth startup uses the OpenCode Zen runtime fallback and sends successfully.
- Runtime `-c` provider config uses underscore-safe provider ids, so Zen/OpenRouter/custom providers are actually registered with Codex app-server.
- Provider switching is scoped to the selected provider and does not require changing the model dropdown directly.
- Invalid/expired auth stays on the Codex provider path and renders the final auth failure as a persisted chat error.
- A new live error is still visible when an older persisted turn error exists, but the same live error is suppressed after that exact error has persisted.
- Feedback mailto diagnostics include recent diagnostics, visible page text, and the visible auth error.
- Malformed auth is treated as unusable auth and falls back to Zen.

#### Rollback/Cleanup
- Stop temporary containers with `docker rm -f codexui-what-noauth codexui-what-invalid-auth codexui-what-malformed-auth`.

---

### Reconcile stale task errors after an observer reconnect

#### Feature/Change Name
Clear an old `Task failed / interrupted` overlay when shared state proves that a later turn is running or has completed.

#### Prerequisites/Setup
1. Build and run the current branch. Use an isolated test thread and browser context.
2. Run `pnpm exec vitest run src/task/taskStateReducer.test.ts src/composables/useDesktopState.test.ts`.
3. For browser verification, run `node scripts/test-task-error-recovery.cjs` against `127.0.0.1:4173`. Its intercepted fixtures do not write real threads or credentials.

#### Steps
1. Deliver a non-retryable `interrupted` notification to the observer and verify that its live error is visible.
2. Simulate a reconnect that misses the next turn's start/completion notifications. Return a fresh successful shared snapshot with a different terminal turn ID.
3. Verify that the successful assistant reply remains visible and that the old error and feedback overlay disappear. Reload and verify again.
4. Repeat with a new running turn, a canceled terminal turn, and a failed terminal turn carrying a different error.
5. Return a plain idle read without authoritative session state, then an older successful snapshot with a lower stream cursor after a newer failure.
6. Verify at 375×812 and 768×1024 in light and dark themes.

#### Expected Results
- A successful terminal marker replaces an old failed/canceled state even when realtime lifecycle notifications were missed.
- Fresh task snapshots reconcile the separate live-error map; a new failure displays its own reason instead of an older `interrupted` message.
- Genuine failures remain visible after reload. Plain idle reads and stale cursors cannot clear a newer live failure.
- Recovery reuses existing status/snapshot requests; it adds no polling, history scan, or model request.

#### Rollback/Cleanup
- Browser fixtures live only in the test context; close it to remove synthetic notifications.
- Stop only the temporary Docker containers used for packaged auth verification. Keep the normal 5900 and 5173 services running.

#### Verification Evidence
- `pnpm run test:unit`: 477 passed; 2 opt-in DSH integration cases skipped. `pnpm run build` passed, with no frontend chunk above 500 kB.
- CJS entry smoke passed: `node -e "process.argv=['node','codexapp','--help']; require('./dist-cli/index.js')"`.
- `node scripts/test-task-error-recovery.cjs` passed at `http://127.0.0.1:4173/#/thread/00000000-0000-4000-a000-000000000031`, in light/dark themes at 375×812 and 768×1024. Screenshots: `output/playwright/task-error-recovery-{375,768}-{light,dark}.png`. Refresh recovery passed; persisted failure duplicate live-overlay count was zero. These are browser viewport checks, not physical Android tests.
- Packaged image built with `pnpm pack --pack-destination output/failed-state-package` and `docker build -t codexapp-error-recovery:local output/failed-state-package`. Ports 4192 (no auth), 4193 (invalid test API key and a container-local HTTP 401 upstream), and 4194 (malformed test auth) booted. The 401 persisted after refresh; duplicate live-overlay count was zero. Screenshots: `output/playwright/error-recovery-packaged-invalid-{light,dark}.png`.
- The 4192 isolated settings API switched OpenCode Zen → OpenRouter with an empty test key; no model request was sent for the switch. No production credentials or provider configuration were changed.
- Desktop Node benchmark, median of three runs of 50,000 reducer observations: before 20.91 ms, after 21.10 ms. The fix adds no network requests, filesystem reads, timers, or history scans; it only reconciles existing in-memory state. Android timing was not measured.

---
