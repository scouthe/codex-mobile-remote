# Feature: Venus phone conversation window

## Prerequisites

- Existing UI-Venus installation at `~/common/UI-Venus`, with its `.venv`, `deployment/run_mobile.py`, mobile configuration and ADB Keyboard.
- The 8900 midplatform lists `inclusionAI/UI-Venus-2-9B`; the phone is unlocked and authorized in `adb devices`, with ADB Keyboard selected.
- `pnpm run build`; persistent installation runs through `codexapp-5900.service`.
- For isolated development: `CODEXUI_APP_SERVER_SOCKET=~/.codex/app-server-control/app-server-control.sock VENUS_AGENT_STATE_DIR="$PWD/output/phone-agent-state" pnpm run dev --host 127.0.0.1 --port 4173` (use an absolute socket path when setting an environment variable).

## Steps

1. Open `http://127.0.0.1:4173/`, click **手机 Agent**, and confirm the `#/phone-agent` route, phone model and current screenshot. Check the existing Codex chat and Skills routes still work.
2. Send `打开系统设置，进入关于手机页面，读取手机型号和 Android 版本并告诉我，不修改任何设置。` with a 12-step limit. Reload while the model loads.
3. Verify only one task exists after reload. Watch step messages, increasing step counts, screenshot changes, and the final answer. Refresh again and inspect history and step details.
4. Send a follow-up to the selected completed task. Verify `request.json` includes a bounded previous goal/result plus the new instruction. Click **新任务** before another submission and confirm no previous context is passed.
5. Start another task, click **停止任务**, and wait for **已停止**. Check the worker exits, the midplatform lease is released, and no subsequent phone actions occur. A second submission during execution must return 409.
6. Disconnect the device, refresh the connection and verify sending is disabled with a useful connection message. Reconnect and retry. Simulate a 503 response from `/phone-agent-api/state`; the page must show an error and recover through **重试**.
7. Verify desktop, 375×812 and 768×1024 layouts in both themes. On smaller layouts use **手机画面 / 返回对话**, confirm the composer remains usable and there is no horizontal page overflow.
8. With web authentication enabled, request `/phone-agent-api/state` using an unauthenticated external host. It must remain behind the same login gate as the existing application.

## Expected Results

- Tasks execute through the installed local Venus policy and 8900 GPU lease, without a new model installation or a separate public service.
- The server owns execution: tab closure/reload does not restart the task or submit it twice. Completed task records, events and screenshots persist under `~/.codex/phone-agent`; the conversation lists the latest 100 tasks.
- Stop signals bypass the policy retry loop, release the outer GPU lease and end the worker. A hard timeout terminates a worker that cannot exit.
- Cold loading warms the instance before requesting a lease, so stopping while the initial HTTP load is pending does not strand an unknown lease. An already submitted model inference may finish in the background; the phone worker stops and performs no more actions.
- Completion/stopped status is published after the process closes, so the next task can be submitted immediately. Invalid model actions stop with a useful message; raw diagnostic output is stored in the run directory rather than repeatedly issuing invalid actions.
- Model events carry small metadata and screenshot filenames, never base64 images; the browser downloads only the selected preview. Device reads are cached and concurrent reads coalesce.
- Only the phone route loads its UI module and starts phone polling. Polls are sequential, pause while hidden, run every 2 seconds for an active task and 15 seconds while idle, and stop on navigation.

## Rollback/Cleanup

- Stop any active task before restarting the web service. Keep phone settings unchanged by using read-only sample goals.
- Isolated test history is in `output/phone-agent-state`; remove that directory only when its screenshots/history are no longer needed. Production task records are separate.
- `VENUS_AGENT_ROOT`, `VENUS_AGENT_STATE_DIR` and `VENUS_ADB_PATH` optionally override paths. The existing web authentication policy also applies to the new endpoints.

## Automated Checks

```bash
pnpm exec vitest run src/server/phoneAgent.test.ts src/server/authSetup.test.ts src/server/uploadLimits.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
pnpm run build
node dist-cli/index.js --help
node -e "process.argv = ['node', 'codexapp', '--help']; require('./dist-cli/index.js')"
```

Browser evidence and request/performance counts are saved under `output/playwright/phone-agent-*`.

## Verified Locally (2026-10-24)

- 20 related unit/API/auth tests passed; after tightening the completion/close ordering, all 8 phone-agent tests passed again. Frontend build, server typecheck, CLI bundle build and the exact CommonJS `require` command above succeeded.
- The production URL `http://127.0.0.1:5900/#/phone-agent` completed a real Redmi K60 Ultra task, returning `已返回桌面。` after 2 steps. Reload restored the result and action list. Browser page errors: zero.
- Light/dark screenshots were verified at 1440×1000, 375×812 and 768×1024. On mobile, the latest result remains in view above the composer; no horizontal overflow was observed.
- Cold-load cancellation left zero inference leases. Cancellation during inference stopped the phone worker in 0.2 seconds; all model proxy leases were also observed released after the outstanding request finished.
- Performance audit: the lazy phone UI chunk is 10.98 kB (4.81 kB gzip). A one-task state response sampled at 495 bytes took about 102 ms with a fresh device read and under 1 ms from cache. The off-route check observed zero phone requests over 4.5 seconds. Reload did not duplicate either of the two browser task submissions. Preview JPEGs in the production run were about 60–76 kB.
- Model limitations remain visible: a more complex system-information task reached its 12-step bound; a transient invalid action response was also observed. These are surfaced as incomplete/error states, not successful phone operations.
