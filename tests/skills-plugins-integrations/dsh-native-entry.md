# Feature: DSH native interface behind the existing web entry

## Prerequisites / Setup

- An independently installed/running DSH web profile. Keep its packages, profile, plugins, model settings, sessions, and systemd unit unchanged.
- Configure `$CODEX_HOME/dsh-bridge.json` as documented in README. Use the listener's actual address, not an assumed loopback bind. The service user must be allowed to read the configured systemd unit's journal when `journalUnit` is selected.
- For a non-systemd deployment, configure the original launch URL through `launchUrl`. Keep that file private (`0600`) and outside Git. No launch token or backend Cookie belongs in frontend code, logs, screenshots, or browser storage.
- Check the listener/cwd on `127.0.0.1:4173` before reusing it; use `pnpm run dev --host 127.0.0.1 --port 4173`. Production uses the normal 5900 build and service.

## Exact Actions / Expected Results

1. Open the normal Codex home. Expect no `/dsh/` or `/dsh-api/` request and no DSH JavaScript in the outer application's eager bundle.
2. Select **DSH**. Expect `#/dsh`, one native status request, and an iframe at the same origin's `/dsh/`. There is no outer ACP session list, project picker, composer or second native toolbar. The original DSH UI, workspace/session list, models and plugin menu must appear without another login prompt. Inspect the real iframe, not just the outer navigation. No `/agent-api/` call or separate ACP process is required by this page.
3. Verify plugin combo URLs such as `/dsh/plugins/??@deepseek-ai/dsh-client-modules/client.js,...&rev=...` return normally. Preserve their query bytes; converting them into ordinary URLSearchParams breaks the original loader.
4. Open an existing DSH conversation, reload the page, and verify its history remains available. Do not send a model prompt as part of entry-only verification. Compare a plugin's direct and proxied response if it reports a permission error; existing DSH policy restrictions must remain intact.
5. Verify the real DSH WebSocket `/dsh/api/remote.mux` and any plugin sockets connect. Leaving the route must tear down that iframe's sockets; it must not stop the independent DSH service or send an interrupt.
6. Open the outer **更多 DSH 操作** menu and use **重新加载**, **全屏**, and **独立打开**. Each keeps the native DSH surface and stays on the 5900 origin. Fullscreen fallback must remain usable on browsers without fullscreen support. On mobile the tool picker remains at the top center; the native page owns its own sidebar/new-chat controls.
7. Check 1440×1000, 375×812 and 768×1024 in light/dark themes. Outer controls stay visible and do not cause horizontal overflow. DSH retains its own appearance settings; the bridge does not alter them.
8. Test with an external Host and no 5900 session: HTML, assets and status require the existing web login; WebSocket upgrade returns 401. A mismatched Origin or cross-site marker must be refused before internal credentials are added. Check both production and Vite's DSH adapter.
9. Exercise binary upload/download with a fixture. Expect exact bytes, streaming/backpressure and original content headers. The outer Cookie/Authorization must not reach DSH; DSH cookies must not reach the browser. Internal redirects stay under `/dsh/`.
10. Simulate unavailable/expired backend authorization with a fixture. Expect a readable error and explicit retry; the next connection obtains fresh internal authorization. Never automatically replay a submitted POST. Verify 5900's Codex routes still work when DSH is unavailable.
11. Verify the same entry through LAN, Tailscale and the existing StarBridge HTTPS domain. Browser requests must not dial a private `:8080` URL or produce HTTPS mixed-content errors. Real Android file-picker verification is separate from browser viewport checks.
12. With the production service worker active, open Codex first and then DSH. Inspect the app-shell cache: `/` must still contain the Codex document, not DSH HTML; DSH assets/status must not be captured by the outer worker. The v3 shell cache retires earlier cached DSH documents. DSH retains its own cache behavior.
13. Open old `#/dsh/native` and `#/dsh/session/<old-display-id>` links, including a browser that remembered an ACP route. They redirect to `#/dsh` and display the native interface. Switching back to Codex restores its last route. These redirects do not map old ACP display IDs to a native conversation.
14. Simulate a failed `/dsh-api/status`: display a readable error and retry button with no iframe. Retry after recovery loads the native page once. Explicit reload obtains one new status response and replaces the iframe; it does not submit any model prompt or modify DSH settings.

## Automated Checks

```bash
pnpm exec vitest run src/server/dshBridge.test.ts src/server/authSetup.test.ts src/cache/serviceWorker.test.ts
pnpm exec vitest run src/composables/workspaceNavigation.test.ts
node scripts/test-dsh-workspace.cjs
node scripts/test-workspace-header.cjs
pnpm exec tsc -p tsconfig.server.json --noEmit
pnpm run build
node -e "process.argv = ['node', 'codexapp', '--help']; require('./dist-cli/index.js')"
```

## Performance Audit

- The bridge is idle until explicitly entered. It starts no DSH process and performs no periodic status polling.
- Internal authorization is shared across simultaneous asset requests and cached until expiry or a backend 401. Journal reads occur only for a new authorization, with a 5-second timeout, a last-entry query, and a 32 KiB output cap.
- HTTP uploads/downloads and WebSockets are piped with backpressure. The bridge never buffers a whole image, file or plugin bundle; there is no new conversation cache or history scan.
- Measure the original UI's request/byte counts, authorization/status counts and mount timing. Check a Codex-only mount makes zero DSH requests and leaving DSH closes its sockets. Record observations under `output/playwright/dsh-entry-*`; distinguish loopback browser checks from physical APK/public-network checks.
- The native-only workspace bundle is 4.83 kB / 2.29 kB gzip, down from the prior ACP workspace's 26.36 kB / 9.82 kB gzip. Shared layout/header code is a separate 4.28 kB / 1.95 kB gzip chunk. DSH no longer imports the remote composer, Android attachment bridge or conversation renderer; the native application's own resources remain its largest load cost.
- Status is read once per entry or explicit reload, with no timer polling or history scan in the outer page. Switching away unmounts the iframe and releases its sockets. Existing native authorization caching and streamed HTTP/WS forwarding are unchanged.

## Native-only entry verification

`node scripts/test-workspace-header.cjs` uses controlled Codex/native-frame fixtures at
`http://127.0.0.1:4173`. It checks 320x812, 375x812, 768x1024 and 1280x900 in light/dark:
Codex controls remain usable, the mobile tool picker is centered, DSH has no duplicate sidebar,
old saved routes resolve to the native page, and no ACP or model prompt request is submitted.

`node scripts/test-dsh-workspace.cjs` checks the actual native DSH app at the same host in
375x812, 768x1024 and 1280x900 light/dark browser contexts. It inspects the real iframe and
native WebSocket, reload/legacy URLs, full-width layout, and socket cleanup on tool switch.
Its final unavailable/retry case uses explicit request fixtures. It sends no prompts, creates
no sessions or temporary projects, and changes no native profile/plugin settings.
Browser Use is unavailable here; Playwright CJS provides request interception and frame checks.
Evidence paths are `output/playwright/dsh-embedded-{375,768,1280}-{light,dark}.png` and
`output/playwright/dsh-embedded-results.json`. Outer light/dark controls are tested; the native
app retains its own appearance settings.

Real native UI readiness was 613–732 ms on this host's warm loopback service, with one status
request per entry and zero ACP requests, page errors or outer overflow. All native sockets
closed when returning to Codex. Native-only failures/retry and legacy redirects passed.
These browser viewport checks do not measure physical Android performance or a carrier network.

After rebuilding/restarting only `codexapp-5900.service`, authenticated LAN 1280x900 and
StarBridge HTTPS 375x812 checks both loaded the actual native app with its main/sidebar WebSockets,
zero page errors and zero ACP calls. The LAN check opened the existing plugin-installation
conversation, verified nonempty history and verified it again after reload. The public check
verified native app readiness, without selecting that history. Total load/check time including
the 2.2-second screenshot settle was 3.5 s LAN / 14.2 s public in this run; native assets dominate
the public cold load. Results/screenshots: `output/playwright/dsh-embedded-production-results.json`,
`dsh-embedded-production-lan.png` and `dsh-embedded-production-public.png`.

`pnpm run test:unit`: 509 passed, three opt-in DSH integration cases skipped. Vue/frontend and
server typechecks, `pnpm run build:frontend`, `pnpm run build:cli`, the CJS smoke command above
and `git diff --check` passed. The obsolete ACP-only browser scenarios were removed/replaced;
backend ACP display data and DSH's original profiles/history remain on disk.

![Embedded native DSH on mobile](../../output/playwright/dsh-embedded-375-light.png)

## Compact mobile outer header

Prerequisites: the current checkout on 4173 and the existing native DSH bridge. Open `#/dsh`
at 375x812 in light/dark; also check 768x1024 to confirm the desktop layout remains intact.
The regular `node scripts/test-workspace-header.cjs` and `node scripts/test-dsh-workspace.cjs`
commands above exercise the changed controls and real frame. Browser Use is unavailable here,
so these use Playwright CJS without changing native DSH preferences or sending prompts.

Expected: the mobile outer header is 45 px high when the top safe-area inset is zero (previously
65 px), the tool picker remains centered and 44 px high, and the More hit area stays 44 px high.
Top safe-area inset is still honored. The native frame begins at y=45 and gains 20 px of reading
space. There is no hidden title row, extra vertical gap, overlap or horizontal overflow; desktop
header sizing stays unchanged. Screenshots: `output/playwright/dsh-embedded-375-{light,dark}.png`
and `workspace-header-{320,375,768,1280}-{light,dark}-dsh.png`, at `http://127.0.0.1:4173/#/dsh`.

Performance: this is a scoped CSS layout adjustment. It adds no requests, event handlers, timers,
DOM nodes or iframe remounts; native status loading and connection lifetime remain unchanged.
The measured mobile header shrank 65 → 45 px, with the iframe top moving by exactly 20 px.
Physical phone frame timing was not measured. Cleanup is limited to closing the browser contexts;
rollback by reverting the spacing styles, rebuilding the frontend and restarting 5900.

Verified with the frontend build, both browser scripts and the deployed StarBridge HTTPS page
at 375x812. Production measured header/frame top 45 px and tool/More controls 44 px; screenshot:
`output/playwright/dsh-compact-production-mobile.png`. No browser assertion failed in the final runs.

## Verified Locally (2026-10-25)

- Real original DSH UI loaded through the bridge in all six combinations of 1440×1000, 375×812, 768×1024 and light/dark themes. Outer page errors and horizontal overflows were zero. An original session's history was readable and remained listed after reload. No model prompt was sent.
- On local 4173, entering DSH made exactly one status request; Codex-only mount made zero DSH requests. Both `/dsh/api/remote.mux` and the existing sidebar plugin socket closed when leaving the route. UI readiness measured 0.57–0.64 seconds on loopback with the service warm; the original DSH page transferred about 6.2 MB and decoded about 16.4 MB in fresh contexts, so public cold loads remain larger than the outer 2.33 KB lazy entry chunk.
- Production 5900 rendered the original DSH UI over loopback, LAN, Tailscale and the existing StarBridge HTTPS domain, with both WebSockets connected and zero page errors. Public mobile viewport load took about 14 seconds before the screenshot's extra 2.5-second settle. These measurements originate from this host; they do not measure a physical phone/carrier connection.
- The existing Task Board plugin returns 403 both directly on original 8080 and through the bridge. Its loopback policy is deliberately unchanged. DSH process PID and start time remained unchanged throughout deployment; only 5900 was restarted.
- All 450 tests across 49 files, Vue/server type checks, production builds, the exact CommonJS smoke command above and `git diff --check` passed. The production service worker retained the Codex home in `codexweb-shell-v3`, cached no DSH resources, and removed the old cache. Vite's new DSH adapter returned 401 for an unauthenticated external Host.
- Screenshots/reports are `output/playwright/dsh-entry-{1440,375,768}-{light,dark}.png`, `dsh-entry-verification.json`, and `dsh-entry-production-{local,lan,tailscale,public}.png` / `dsh-entry-production.json`.

## Rollback / Cleanup

- Disable the entry by removing its optional local bridge configuration and reverting this feature's code, then rebuild/restart only 5900. Keep all DSH profile, history and plugin files.
- Close test browser contexts. Do not stop or restart DSH, invoke model turns, change its theme/profile, or replace its service unit during entry-only acceptance.
- Test artifacts under `output/playwright/dsh-entry-*` are ignored local output. No credentials belong in committed files.
