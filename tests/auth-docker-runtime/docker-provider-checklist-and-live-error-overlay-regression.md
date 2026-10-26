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

### Duplicate rollout records must not overwrite current task state

#### Feature/Change Name
Deduplicate thread IDs before reading session activity, caching summaries, and normalizing the sidebar. Keep the newest record without copying task errors from an older rollout.

#### Prerequisites/Setup
1. Run `pnpm run test:unit` and `pnpm run build`.
2. Keep the current branch's verification server running on `127.0.0.1:4173`.
3. Use synthetic sessions or a thread already containing multiple rollout files with the same ID. Do not delete or rewrite real history to create this condition.

#### Steps
1. Return a thread list containing a current rollout and an older rollout with the same ID. Make the old file terminate with `interrupted`; test both list orders.
2. Test the current file while running, after successful completion, and after a real provider failure. Request both the first page and a cursor page.
3. Check that database supplementation updates the canonical record once, preserves the cursor, and does not overwrite a newer official record with an older cached row. Include duplicate supplemental records and an empty supplement.
4. Fetch an older cursor page after caching the current summary. Verify the cached fallback still points at the current rollout.
5. Run `node scripts/test-task-error-recovery.cjs` and `TASK_ERROR_TEST_ANDROID_CACHE=1 node scripts/test-task-error-recovery.cjs`. Both fixtures now return the real duplicate-ID pattern on every list refresh.
6. At 375×812 and 768×1024 in light/dark themes, verify initial load, reconnect, and reload. Confirm successful snapshots clear the old error and genuine new errors remain visible.
7. After deploying, query the affected instance's `thread/list` repeatedly with limits 40 and 1000. Check unique IDs, the affected thread's current path, and its task state/error. Open and reload the same thread over LAN and the public relay.

#### Expected Results
- Exactly one row per thread ID reaches activity reconciliation, even when rollout paths or project directories differ. A newer record replaces the old record as a whole; equal timestamps keep the first record deterministically.
- Old `interrupted` records cannot overwrite a newer running/completed task or replace the reason for a genuine new failure.
- Activity reads use only the selected rollout, once per path per response. Pagination cursors are preserved; list updates do not roll the fallback summary cache backward.
- New unsent forks remain visible through the existing supplement. No sessions, databases, or official Codex configuration are modified by deduplication.
- A production check during a running turn proves only its current API/browser state. Physical Android and post-completion production behavior must not be claimed from viewport simulation alone.

#### Rollback/Cleanup
- Close synthetic browser contexts and remove only the named isolated auth-test containers.
- If a rollback is necessary, revert the deduplication commit, rebuild, and restart only `codexapp-5900.service`. Do not alter rollout files or restart the independent official app-server.

#### Verification Evidence
- Before the fix, the affected 5900 list returned 211 rows with seven duplicate-ID groups. The affected ID had both a current running rollout and an older failed rollout carrying `interrupted`.
- All 14 added regression cases passed; full suite: 497 passed, two opt-in DSH integration cases skipped. Build and public CJS-entry smoke passed.
- Browser fixtures passed at both viewports in light/dark themes, including simulated Android bridge callbacks and real IndexedDB hydration. Screenshots: `output/playwright/task-error-recovery-{375,768}-{light,dark}.png` and `output/playwright/task-error-recovery-android-cache-{375,768}-{light,dark}.png`. Genuine failures persisted after reload, with zero duplicate live error overlays.
- After restarting only the 5900 user service, three real list requests (limits 40, 1000, 40) returned 200 unique rows, no duplicate IDs, and one current affected-thread record with `taskState: running` and an empty task error.
- LAN and public-relay browser checks at 375×812 passed before and after reload in light/dark themes, with a simulated Android observer bridge: no live error, false failed native callback, or page error. Screenshots: `output/playwright/task-error-production-{lan,public}-375-{light,dark}.png`. This checked the current running production turn; completion was covered by synthetic HTTP/browser fixtures, not a physical Android device.
- Final packed-image checks used ports 4192 (no auth), 4193 (invalid fixture key with container-local 401 upstream), and 4194 (malformed auth). All booted; 4193's genuine auth failure persisted after reload with zero duplicate live overlays. Switching 4192 from OpenCode Zen to OpenRouter with an empty test key succeeded without a model request. Commands: `pnpm pack --pack-destination /tmp`, `docker build -t codexapp-error-recovery:local output/failed-state-package`, `node output/failed-state-package/verify.cjs`. Screenshots: `output/playwright/error-recovery-packaged-invalid-{light,dark}.png`.
- The pure O(n) selection took a median 0.017 ms for 211 synthetic rows and 0.403 ms for 10,000 rows on desktop Node (101 measured iterations after warmup). It adds no RPCs, database queries, filesystem reads, timers, or unbounded concurrency. HTTP regressions assert that the older duplicate file is never read. Physical Android timings were not measured.
- The browser recovery scenarios still used 98 API requests at 375px and 107 at 768px, with zero model calls. The desktop-state chunk increased from 195.36 kB to 195.78 kB (gzip 54.68 → 54.80 kB); the largest frontend chunk remained 342.64 kB.

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
7. Run `TASK_ERROR_TEST_ANDROID_CACHE=1 node scripts/test-task-error-recovery.cjs`. This enables the Android bridge and seeds real IndexedDB with an incomplete cache. Its mandatory history hydration returns an older failed turn while the shared marker identifies a newer completed turn.

#### Expected Results
- A successful terminal marker replaces an old failed/canceled state even when realtime lifecycle notifications were missed.
- Fresh task snapshots reconcile the separate live-error map; a new failure displays its own reason instead of an older `interrupted` message.
- Genuine failures remain visible after reload. Plain idle reads and stale cursors cannot clear a newer live failure.
- Android cache hydration does not promote an older turn's `interrupted` error into the current task. The native bridge must not receive a failed state for the newer completed turn. Matching current-turn provider failures remain visible even when their JSONL terminal marker is generic `task_complete`.
- Recovery reuses existing status/snapshot requests; it adds no polling, history scan, or model request.

#### Rollback/Cleanup
- Browser fixtures live only in the test context; close it to remove synthetic notifications.
- Stop only the temporary Docker containers used for packaged auth verification. Keep the normal 5900 and 5173 services running.

#### Verification Evidence
- `pnpm run test:unit`: 483 passed; 2 opt-in DSH integration cases skipped. `pnpm run build` passed, with no frontend chunk above 500 kB.
- CJS entry smoke passed: `node -e "process.argv=['node','codexapp','--help']; require('./dist-cli/index.js')"`.
- `node scripts/test-task-error-recovery.cjs` passed at `http://127.0.0.1:4173/#/thread/00000000-0000-4000-a000-000000000031`, in light/dark themes at 375×812 and 768×1024. Screenshots: `output/playwright/task-error-recovery-{375,768}-{light,dark}.png`. Refresh recovery passed; persisted failure duplicate live-overlay count was zero. These are browser viewport checks, not physical Android tests.
- `TASK_ERROR_TEST_ANDROID_CACHE=1 node scripts/test-task-error-recovery.cjs` passed at the same URL/viewports/themes, using a simulated native bridge and real IndexedDB. The incomplete-cache hydration fixture has a legacy string `interrupted` error in an older projected turn; its newer shared terminal marker stays completed. Native task callbacks did not report a false failure. Screenshots: `output/playwright/task-error-recovery-android-cache-{375,768}-{light,dark}.png`. This closes a gap in the earlier browser-only recovery test; it is not physical Android evidence.
- Packaged image built with `pnpm pack --pack-destination output/failed-state-package` and `docker build -t codexapp-error-recovery:local output/failed-state-package`. Ports 4192 (no auth), 4193 (invalid test API key and a container-local HTTP 401 upstream), and 4194 (malformed test auth) booted. The 401 persisted after refresh; duplicate live-overlay count was zero. Screenshots: `output/playwright/error-recovery-packaged-invalid-{light,dark}.png`.
- The 4192 isolated settings API switched OpenCode Zen → OpenRouter with an empty test key; no model request was sent for the switch. No production credentials or provider configuration were changed.
- Desktop Node benchmark, median of three runs of 50,000 reducer observations: before 20.91 ms, after 21.10 ms. The fix adds no network requests, filesystem reads, timers, or history scans; it only reconciles existing in-memory state. Android timing was not measured.
- History normalization adds only constant-time state/turn-ID checks. The recovery sequence made 98 API requests at 375px and 107 at 768px, identical with and without Android cache mode across three page loads and the synthetic recovery scenarios; zero model requests were sent. The production desktop-state chunk changed from 195.26 kB to 195.36 kB (gzip 54.64 → 54.68 kB).

---
