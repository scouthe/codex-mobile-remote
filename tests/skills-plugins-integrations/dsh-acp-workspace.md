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
   one event stream and one session list; it does not initialize Codex or start DSH before needed.
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
11. For native fallback, configure `dsh-bridge.json`, open More → DSH native UI, and verify HTTP
    and WebSocket requests use the authenticated proxy. Existing DSH plugins/config stay unchanged.
12. Verify `/agent-api/*`, `/dsh/*` and native WebSockets reject unauthorized/cross-origin access
    and bypass service-worker caching. Large invalid JSON bodies return 413 without buffering
    the whole body. Malformed JSON/options return 400, without starting DSH.

## Automated commands / evidence

```bash
pnpm exec vitest run src/server/agents src/composables/useAgentState.test.ts src/server/dshBridge.test.ts src/cache/serviceWorker.test.ts
CODEXUI_TEST_DSH=1 pnpm exec vitest run src/server/agents/dsh.integration.test.ts
CODEXUI_DSH_LIVE_TEST=1 pnpm exec vitest run src/server/agents/dsh.integration.test.ts
DSH_UI_LIVE_PROMPT=1 node scripts/test-dsh-workspace.cjs
node scripts/test-dsh-interactions.cjs
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
