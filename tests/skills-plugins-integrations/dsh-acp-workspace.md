# DSH ACP workspace

## Prerequisites / setup

- Install and configure DSH on the 5900 host. The current acceptance target is `0.2.1-rc.2`.
- Keep the existing Codex shared app-server and optional DSH Web service unchanged.
- Build with `pnpm run build` and run unit tests with `pnpm run test:unit`.
- For an isolated source check, first verify the listener/cwd on 4173, then run:

```bash
CODEXUI_AGENT_HOME=/tmp/codex-remote-acp-4173 pnpm run dev --host 127.0.0.1 --port 4173
```

The DSH executable/profile can be configured with `dsh.json` under the selected agent home.
Do not share one display store between two live servers. Real DSH tests use the installed engine
and may make small upstream model requests. All file-tool tests must use temporary projects.

## Actions and expected results

1. Open `http://127.0.0.1:4173/#/dsh` directly. Check Codex/DSH tabs, the DSH header label,
   project picker and New DSH chat. The initial request set contains status, directory listing,
   one event stream and one session list. Listing initializes DSH to negotiate capabilities and
   call `session/list`; it does not initialize Codex, resume sessions, or submit prompts.
2. Browse a temporary project and create a chat. It appears in the DSH sidebar immediately,
   before sending a message. No Codex thread is created. While a directory is loading, its
   path input is disabled so a late response cannot replace a newly entered path.
3. Change model and reasoning options, then restore their original values. Values are opaque
   DSH identifiers; do not substitute Codex model names or effort enums.
4. Send a harmless text prompt. Verify a final answer, collapsed process messages, generic tool
   lifecycle if tools are used, and visible errors if launch/model/attachment validation fails.
5. If DSH declares image support, add a standard PNG from the image picker and the file picker.
   A thumbnail and upload progress/error must appear. Submit and verify an actual image reply.
   A PNG with missing MIME metadata is identified by extension. Unsupported image formats are
   rejected visibly. Without image support, no image button is shown and image additions explain
   why they cannot be sent. Uploaded non-image files become local resource references.
6. Trigger a permission request in a temporary project. Approve/reject the exact provided option.
   Confirm the card disappears, the task resumes/finishes, and stopping cancels pending approvals.
   Refresh while waiting for approval; the same request is still actionable.
7. Simulate a temporary event-stream interruption. Existing display remains visible, reconnect
   reads durable state and restores missed output. No prompt is automatically resubmitted.
   Retry the same accepted request ID: only one native prompt and user message are created.
8. Enter different drafts in two DSH chats; switch and reload. Drafts/attachments remain scoped
   to their DSH chat. Scroll upwards, change chats and return: the reading position is retained.
   Switch to Codex and back while DSH is running: both tasks keep their own state and history.
9. Restart only the isolated workbench, then reopen a completed DSH chat. Display history remains,
   and a follow-up restores the same native DSH context. An unconfirmed running task is marked
   interrupted, not permanently loading or automatically replayed. Test history pagination across
   multiple 64 KiB boundaries and a torn final append; later writes remain readable.
10. At 1280x900, 375x812 and 768x1024, inspect light/dark themes, model menus, approvals, mobile
    drawer/tool picker and keyboard-safe controls. No horizontal overflow, hidden popup or
    Codex-only Fork/rollback/Goal/Fast action should appear on DSH chats.
    The header uses the same sidebar/new-chat icons as Codex. On mobile, Codex/DSH tool buttons
    sit at the top center, with the conversation title below; tool switching takes one click.
    See `tests/theme-layout-terminal/content-header-actions-remain-right-aligned.md` for the
    responsive header regression, including draft restoration and desktop sidebar controls.
11. For native fallback, configure `dsh-bridge.json`, open More → DSH native UI, and verify HTTP
    and WebSocket requests use the authenticated proxy. Existing DSH plugins/config stay unchanged.
12. Verify `/agent-api/*`, `/dsh/*` and native WebSockets reject unauthorized/cross-origin access
    and bypass service-worker caching. Large invalid JSON bodies return 413 without buffering
    the whole body. Malformed JSON/options return 400, without starting DSH.

## Native ACP capabilities: discovery, resume, close, MCP and usage

Prerequisites: DSH must declare `sessionCapabilities.list/resume/close`. The installed
`0.2.1-rc.2` implements these but not `session/load`, audio prompts or Fork. Do not resume an
active user session for testing; use browser fixtures or a disposable native session/profile.

1. Open `#/dsh` and expand the sidebar. Native resumable sessions appear grouped by cwd alongside
   managed sessions. Load subsequent pages using “加载更多原生对话”. Each native ID appears once,
   including when pages overlap. Refresh/restart preserves its display ID. An archived local
   record stays hidden without deleting or modifying the original DSH conversation.
2. Select a native row. It must **not** call activate/resume/prompt. Its banner explains missing
   history replay and offers “恢复原生会话” and “查看原生历史”. No misleading “No messages” state or
   composer appears before restoration. Current DSH returns only ID/cwd, so the UI uses an ID
   label rather than claiming to synchronize the original title. Native active sessions may be
   absent until their owner releases them.
3. Explicitly restore a disposable native session. The original opaque native ID and cwd are
   passed unchanged, config options appear, and the composer becomes usable. More → release
   disconnects the native writer while retaining the row/display history. A later prompt result
   must not change an explicitly closed task back to completed. Pending permissions are cancelled.
4. Reconnect while a list/detail response is delayed. New state/pagination wins over the old
   response, and no prompt is replayed. Simulate a failed list: saved sessions remain available,
   a visible warning offers retry, and retry replaces the warning. Missing list/close capability
   never causes an unsupported method call. Invalid cwd/overlong cursor return 400 before dispatch.
5. Send a valid `usage_update` fixture. A context count appears without inserting a transcript
   message or polling; malformed negative/zero values do not replace the previous valid count.
6. In an isolated agent home, add stdio/HTTP declarations to `dsh.json.mcpServers` as shown in
   README. Both create and resume receive them unchanged. No MCP credentials are exposed through
   session/status routes or validation errors; duplicate names, relative commands and invalid
   URLs are rejected. A transport the agent has not declared (e.g. SSE here) is rejected before
   session creation. Restore the original configuration after checking.

Automated evidence:

```bash
node scripts/test-dsh-native-sessions.cjs
CODEXUI_DSH_DISCOVERY_TEST=1 pnpm exec vitest run src/server/agents/dsh.integration.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The script uses request/stream fixtures at `http://127.0.0.1:4173/#/dsh`, including session routes.
It checks native discovery/pages, explicit restoration, close, usage, stale-list reconciliation
and warning retry at 375x812 and 768x1024 in light/dark mode; no model calls or native writes.
Screenshots: `output/playwright/dsh-native-{375,768}-{light,dark}.png`.

![Native session mobile dark theme](../../output/playwright/dsh-native-375-dark.png)

Performance review: the first view requests one native page, with no eager pagination or full
transcript scans. Concurrent discovery requests share one RPC; the native page cache expires
10 seconds after its read (cache hits do not extend TTL), holds at most 16 pages, and is invalidated
by create/archive/close/process exit. Only new display metadata is written; existing imports do
not rewrite transcripts. Pagination/reconnect fixtures verify no duplicate initial list request.
The DSH workspace remains lazy loaded: build output 26.36 kB / 9.82 kB gzip (previous 22.88 kB).
MCP config is read only at new/resume, and usage uses existing notifications rather than requests.
Native `session/list` may scan its own persistence; that implementation belongs to DSH.
No physical-phone CPU or very-large native-store benchmark was performed in this change.

Deployment acceptance (5900): authenticated reads at `http://192.168.1.148:5900/#/dsh` and
the configured Xingqiao HTTPS address returned 12 visible sessions, including both older
default-workspace native IDs and the original managed chat. Native rows were opened read-only
on a 375x812 browser; no activate/prompt/close request was issued. LAN initial discovery took
748 ms including process initialization/import, and the following cached request took 3 ms.
Public cached reads took 93/51 ms in this run. These are single-run observations, not a latency SLA.
Screenshots: `output/playwright/dsh-native-live-lan.png`, `dsh-native-live-public.png`.

Packaged Codex regression: `pnpm run build`, `pnpm pack --pack-destination output/failed-state-package`,
`docker build -t codexapp-error-recovery:local -f output/failed-state-package/Dockerfile output/failed-state-package`,
then `node output/failed-state-package/verify.cjs` against isolated containers on localhost
4192 (no auth), 4193 (invalid API key, container-local 401 upstream), and 4194 (malformed auth).
No-auth/malformed states booted with Zen fallback; the invalid-key error survived reload and
duplicate `.live-overlay-inline` count was zero. A POST to `/codex-api/free-mode/custom-provider`
in the 4192 container switched Zen to OpenRouter and status confirmed persistence without
submitting a model prompt. No host credentials/config were mounted. Temporary containers were
removed after validation. Error screenshots: `output/playwright/error-recovery-packaged-invalid-{light,dark}.png`.
Public CJS smoke: `node -e "process.argv=['node','codexapp','--help']; require('./dist-cli/index.js')"`
exited 0 with CLI help. Server and frontend typechecks passed.

## Automated commands / evidence

```bash
pnpm exec vitest run src/server/agents src/composables/useAgentState.test.ts src/server/dshBridge.test.ts src/cache/serviceWorker.test.ts
CODEXUI_TEST_DSH=1 pnpm exec vitest run src/server/agents/dsh.integration.test.ts
CODEXUI_DSH_LIVE_TEST=1 pnpm exec vitest run src/server/agents/dsh.integration.test.ts
DSH_UI_LIVE_PROMPT=1 node scripts/test-dsh-workspace.cjs
node scripts/test-dsh-interactions.cjs
node scripts/test-workspace-header.cjs
pnpm run build
node -e "process.argv=['node','codexapp','--help']; require('./dist-cli/index.js')"
```

The first UI script uses a real DSH connection and temporary project; it checks model/reasoning
changes, optional live text/image replies, post-refresh history/drafts, tool switching, request
counts and responsive screenshots. The interaction script uses explicit browser-side stream and
HTTP fixtures for approval, reconnect, folded processes, draft isolation and TestChat link
assertions (`hrefOk`, `titleOk`, `textOk`). Screenshots are saved under `output/playwright/`.
Browser Use is not available in this environment; these checks use Playwright CJS.

## Rollback / cleanup

- UI test sessions are archived, never deleted from DSH's native store; temporary project
  directories are removed by the scripts. Native DSH test sessions remain owned by DSH.
- Stop only the isolated 4173 process if cleanup is needed; never stop the tmux 5173 service.
- The ACP profile and agent display directory can be backed up and removed after stopping their
  owner if this integration is abandoned. Do not delete the original Web profile, credentials,
  Codex history, or native DSH session directory.
- Temporary package/container checks use unique local ports/names and no production secrets.
