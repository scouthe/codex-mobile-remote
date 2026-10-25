# Feature: On-demand phone mirroring and manual takeover

## Prerequisites / Setup

- Authorized Android phone connected by USB (`adb devices -l`), with USB debugging and input injection enabled. Chinese input additionally requires `com.android.adbkeyboard/.AdbIME` as the current input method.
- Run `pnpm run setup:phone-mirror` once. It installs the official scrcpy **5.0.1** Android server, verifies the pinned SHA-256, and stores it at `~/.local/share/codexapp/scrcpy/5.0.1/server.jar`. `VENUS_SCRCPY_SERVER` overrides that path; the version must still match.
- Use a current Chrome/Edge browser with H.264 MediaSource playback. LAN HTTP works; WebCodecs and a separate video port are not required.
- Verify the current `4173` listener/cwd, then use the existing development server. Do not stop the persistent `5173` server. Production is `http://127.0.0.1:5900/#/phone-agent` after build/service restart.
- Stop unrelated test tasks before exercising the same physical phone from a development server. Production and development processes each own their own task manager.

## Exact Actions / Expected Results

1. Open `http://127.0.0.1:4173/#/phone-agent`. Leave it idle, then visit a different route. Expect no `/control/*` traffic, scrcpy encoder or ADB forward. Normal Agent step screenshots remain available.
2. Start a read-only task, then click **接管手机**. Expect **等待 Agent 停止…**, followed by live video. The task must reach a terminal status after its worker exits before any manual command is accepted. The original goal is shown under **待继续**.
3. Open a second browser and try acquiring the phone or submitting a task. Expect 409 while manual ownership is held; its UI must not enable manual input. Repeated stream connections for the same session must also return 409 without closing the original stream.
4. Click a visible app icon, drag to scroll, and hold a harmless spot for at least 500 ms. Verify the matching tap/swipe/long press on the physical phone. Click black letterboxing: expect no command. Navigation buttons must perform back/home/recent/wake/sleep/enter/delete. **息屏** sends Android's sleep-only key (`KEYCODE_SLEEP=223`) and keeps manual control; pressing it again must keep the display off. **亮屏** uses `KEYCODE_WAKEUP=224`. While the video is still connecting, only **亮屏** may run; this allows waking a sleeping display before a first frame arrives. Confirm physical power with `dumpsys power` / `dumpsys display`: historical screenshots and the last video frame do not establish whether the physical display is on.
5. Open a harmless editable field such as Settings search. Enter `蓝牙` in the web text field and click **输入**. Verify the exact text arrives. Test quotes and punctuation in a non-submitting field; text is encoded as base64, never interpolated into a shell command.
6. Rotate the phone, then wait for the fresh live frame. Expect a new video format/init segment and correct scaled coordinates. An action carrying the old display epoch or mismatched portrait/landscape must return 409, without injecting a tap. Rotation must not require another Agent inference.
7. Click **结束接管** during an ADB command. Expect the server to wait for that command and encoder cleanup before releasing ownership. Video disappears; Agent stays stopped. A subsequent task can start normally.
8. Add a note such as `弹窗已处理` and click **交回 Agent，继续任务**. Expect one new task containing the original goal, prior task context and the note. It observes the current screen before continuing. Video/heartbeat stop; this is a new run, not restoration of the model's internal reasoning state.
9. While manually controlling, hide the browser tab, navigate away, close/reload the page, or on mobile click **返回对话**. Expect video/ADB-forward cleanup and no automatic Agent restart. Reload should preserve this tab's explicit handback context. Reacquiring requires an explicit click.
10. Simulate network loss. Expect a visible error and manual input disabled. On a silent disconnect the server's 18-second lease expires after the last heartbeat, followed by resource cleanup; it never auto-resumes the Agent. Restore connectivity and reacquire explicitly.
11. Check 1440×1000, 375×812 and 768×1024 in light and dark themes. Video, controls and the handback button must be visible without horizontal overflow. Optional notes/text inputs must stay usable.
12. With the existing login gate enabled, request the control/stream paths as an unauthenticated external host. Expect the same login requirement as the rest of the application, with no video or device data.

## Encapsulation / Interfaces

| Module | Responsibility |
| --- | --- |
| `phoneAgent.ts` | Task execution/history and one manual lease. `claimManual()` waits for worker exit and returns a release function; it has no video dependency. |
| `phoneControl/manager.ts` | Acquire/input/release/resume lifecycle, browser ownership, heartbeat expiry, and waiting for all I/O before handback. |
| `phoneControl/scrcpy.ts` | A single encoder, socket, ADB forward and temporary phone jar; constructor is idle and stop is idempotent. |
| `phoneControl/h264Mp4.ts`, `fragmentedMp4.ts` | Bounded scrcpy packet parsing, real presentation timestamps, AVC samples and append-only MP4 fragments. No decoder/transcoder or recording buffer. |
| `phoneControl/adbInput.ts` | Allowed input validation, current logical display coordinates, rotation checks and base64 text. |
| `phoneAgentMiddleware.ts`, `phoneControl/routes.ts` | HTTP adapters assembled behind existing authentication. No new public listener or WebSocket auth path. |
| `phone/videoPlayer.ts`, `gestures.ts` | Browser playback/buffer lifetime and pure gesture/letterbox mapping, independent of Agent conversations. |
| `usePhoneControl.ts`, `PhoneScreenPanel.vue` | Browser ownership lifecycle and screen UI. The conversation receives only ownership and resumed-task events. |

## Performance Audit

- Encoder starts only after explicit takeover and stream attachment: H.264, max side 1280, at most 30 fps, target 2 Mbps, audio/control channel disabled. Hardware encoding runs on the phone; Node parses and remuxes, with no FFmpeg process or GPU inference for manual control.
- MP4 is fragmented per video sample rather than waiting for a new keyframe. Variable frame timestamps and rotation are retained. The relay retains a partial packet and one video sample, rather than accumulating a recording or per-session frame metadata.
- Scrcpy packet buffer is capped at 4 MiB plus a network chunk. HTTP checks a 1 MiB writable-backlog threshold before each packet; queued application data can exceed it by at most one packet (up to 4 MiB), and the next write disconnects a slow viewer. Browser appends serially and removes old playback data, retaining approximately 8 seconds plus codec keyframe alignment.
- Each active browser has a sequential heartbeat every 5 seconds; no heartbeat runs when idle. The 18-second server lease handles silent disconnects. The existing task/state polls remain sequential and stop off-route or while hidden; device discovery coalesces and caches reads.
- Run the actual-phone browser script and record startup time, HTTP video bytes and the server CPU/RSS delta under `output/playwright/phone-control-live.json`. Report measured values separately from bitrate configuration; network and device content affect actual results.

## Automated Checks

```bash
pnpm exec vitest run src/server/phoneAgent.test.ts src/server/phoneControl src/phone/gestures.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
pnpm run build
node -e "process.argv = ['node', 'codexapp', '--help']; require('./dist-cli/index.js')"
```

The tests exercise ownership races, real worker exit ordering, input/encoder drain before resume, lease expiry, stream disconnect, authentication, cancellation during forward creation, byte-split video packets, delta fragments, rotation and letterboxing.

## Verified Locally (2026-10-24)

- 31 related unit/API/auth tests, server typecheck, Vue/CLI builds and the exact CommonJS smoke command above passed. The packaged setup script recognizes the installed server's checksum and is idempotent.
- Actual Redmi K60 Ultra / Android 14: web clicks opened Settings; swiping and long press issued the expected gestures; Settings search received the exact Chinese text `蓝牙`. Six viewport/theme combinations (1440×1000, 375×812, 768×1024; light/dark) passed with no page errors or horizontal overflow.
- Actual video changed from 560×1280 to 1280×560 and back without losing manual ownership. The old epoch returned 409 and a current landscape coordinate returned 200. Temporary rotation/orientation-policy settings were restored to their initial values.
- Network loss released manual control in 3.95 seconds in the browser test, and explicit reconnection succeeded. Mobile screen hiding, route exit and reload released the video. This tab's handback context survived reload. The server lease-expiry test also covered silent disconnects independently.
- Production `5900` completed Agent startup → takeover → manual Home → explicit handback with the original goal and note → a new screenshot and answer. The policy returned `CallUser` with `已确认当前画面为手机桌面，任务完成，已返回桌面。`; its status is therefore `needs_input`. Task completion classification continues to follow the policy's action, including this distinction between its text and terminal action.
- Production sample: first frame 1.33 seconds; takeover of an active worker 1.01 seconds. Over 12.28 seconds on the home screen with two Home presses, video averaged 0.65 Mbps; Node used 1.55% of one CPU core, and observed RSS peaked 1.85 MiB above its 178.85 MiB baseline. This measures the web server, not phone encoder power or browser decoder memory. A more active development sample (app opening/swiping/text input) averaged 1.58 Mbps and 3.19% of one CPU core over 16.28 seconds.
- The lazy phone UI chunk is approximately 24.34 kB / 9.50 kB gzip. An empty-history mount made exactly one state request and one initial screenshot request. Idle pages generated zero control requests; task reload did not duplicate the two explicit start/handback submissions. After manual release and final handback, ADB forward lists and phone scrcpy processes were empty.
- Reports, the live-connection request/performance measurements and screenshots are under `output/playwright/phone-control-*`; the summary report is `output/playwright/phone-control-verification.md`.

## Sleep regression check (2026-10-25)

- Previously the sleep button used `KEYCODE_POWER=26`, which toggles the display and could wake an already sleeping phone. It now uses `KEYCODE_SLEEP=223`; wake remains `KEYCODE_WAKEUP=224`.
- A regression test verifies that two consecutive sleep requests issue only the sleep key. Actual Redmi K60 Ultra verification showed `ON → OFF → OFF`; a fresh screenshot was black and the display remained `OFF` afterward. Results are in `output/phone-power/diagnosis.json`.
- After updating production, attaching its live mirror, submitting sleep twice and releasing the session all kept the physical display `OFF`. Results are in `output/phone-power/production-regression.json`. The current mirror configuration did not reproduce an automatic wake on viewing.
- Performance: the change replaces one numeric argument in the existing single ADB command. It adds no processes, polling, media traffic, or display-state reads to the production input path.

## Rollback / Cleanup

- End manual control and wait for any Agent task to finish before restarting production. Verify `adb forward --list` has no takeover forward and `adb shell ps -A` has no scrcpy server afterward.
- Return the phone to its original screen after test actions. Restore any temporary rotation settings used in testing. The implementation does not alter resolution, install a phone app, grant permissions, or change the default input method.
- Test evidence is in `output/playwright/phone-control-*`; transient UI dumps and probe videos are ignored local artifacts. Keep production history in its existing state directory.
- Reverting this change restores screenshot-only operation. The downloaded server jar can be removed independently from its versioned user directory after active sessions end.
