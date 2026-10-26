### Content header actions remain right aligned

#### Feature/Change Name
Thread and new-chat header action buttons stay pinned to the right edge while long titles remain constrained and truncated.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Sidebar collapsed or viewport wide enough to show content header actions
3. Terminal toggle available in the header

#### Steps
1. Open `http://127.0.0.1:4173/#/`
2. Inspect the header row containing `Start new thread`
3. Verify the terminal toggle is aligned to the far right of the content header, not immediately after the title
4. Open a thread with a long title and repeat the alignment check
5. Confirm the title truncates with a tooltip and does not overlap the terminal or branch controls

#### Expected Results
- Header actions use the available right edge of the content header
- Long title truncation does not pull action buttons toward the center
- Terminal and branch controls remain visible and clickable

#### Rollback/Cleanup
- Remove generated screenshots under `output/playwright/` if they are not needed

---

### Shared Codex / DSH header and compact mobile tool switching

> ACP-specific sidebar, composer and draft scenarios below describe the earlier workspace.
> The current DSH page embeds the native app; see the native-only acceptance below.

> Codex mobile keeps its original single-row header: the Codex / DSH picker sits inline with
> the sidebar/new-chat controls and the thread title. DSH itself retains the centered mobile
> picker because its native page has no outer conversation title.

#### Feature/Change Name
Both workspaces reuse the same tool picker. Codex mobile keeps the original single-row header:
the picker, sidebar/new-chat controls, title and right actions share one row. DSH has no outer
conversation title, so its native page keeps the centered Codex/DSH buttons. The former
Android-observer/desktop-writer header badge is removed.

#### Prerequisites/Setup
1. Verify that the 4173 listener belongs to this checkout before running `node scripts/test-workspace-header.cjs`.
2. The script intercepts Codex/DSH APIs and streams and simulates the Android bridge. It does not create real sessions or send model prompts.
3. For production checks, use the existing 5900 login. Do not change native DSH or official Codex configuration.

#### Steps
1. At 320×812 and 375×812, open a Codex thread. Verify the Codex/DSH picker, sidebar/new-chat
   controls and thread title share one compact row; the title is not moved to a second row.
2. Open the right-hand ellipsis on Codex. Verify the existing Git/review menu is usable. When terminal support is available, its separate button remains visible beside it.
3. Click DSH once. Check that the same leading icons and hit areas stay at the same coordinates, DSH becomes selected, and its own conversation loads. The DSH More menu retains native UI, refresh and appearance actions.
4. Enter a DSH draft, switch Codex → DSH, and verify the draft and last conversation are restored. Open/close the mobile drawer, then use the header new-chat button; it navigates to the DSH start page without creating a Codex thread.
5. At 768×1024 and 1280×900, verify the shared leading controls, tool buttons, truncated title and right-aligned actions. Both desktop sidebars must still open and close.
6. Repeat in light/dark themes. Verify the header, selected tool, icon hover/focus, Git menu and DSH menu use the current theme. Verify no horizontal overflow or Android role badge remains.
7. Run `node scripts/test-dsh-interactions.cjs` for existing approvals, reconnect, history position and per-chat draft behavior.

#### Expected Results
- Opening the compact tool dropdown and choosing Codex or DSH switches using the existing saved workspace routes; choosing the selected tool leaves the route unchanged.
- Mobile sidebar, new-chat and right action hit areas are 44×44 px. The compact picker has a visible label, focus state and keyboard-accessible options.
- A long title cannot move the inline Codex picker or cover right actions. Desktop keeps its inline title and full Git branch label.
- Removing the role badge changes presentation only; Android observer behavior and native task notifications remain intact.
- The change adds no API, timer, polling, process, database access or history scan. The Codex-only fixture makes zero DSH API requests before explicitly switching.

#### Verification Evidence
- `pnpm run test:unit`: 497 passed, two optional DSH live tests skipped. `pnpm run build` passed.
- `node scripts/test-workspace-header.cjs` passed in all eight viewport/theme combinations. Codex's
  single-row mobile header, DSH's centered picker, Git/DSH menus, native frame, legacy route
  redirects and zero model/ACP requests passed with zero page errors. Each full flow made 40–43
  existing API calls, including menu loads and workspace switches.
- The final run also covered long conversation titles and both Codex terminal/Git controls being
  present at 320px. Neither right action overlaps the inline switch.
- `node scripts/test-dsh-workspace.cjs` passed for the native DSH iframe, socket cleanup and unavailable/retry behavior.
- Screenshots: `output/playwright/workspace-header-{320,375,768,1280}-{light,dark}-{codex,dsh}.png`. Tested routes: `http://127.0.0.1:4173/#/thread/00000000-0000-4000-a000-000000000051` and `#/dsh/session/00000000-0000-4000-a000-000000000051`. These are browser/simulated Android checks, not physical APK acceptance.
- The compact picker uses the existing ComposerDropdown and navigation function; no workspace
  loading/caching logic changes. The frontend build and physical Android frame timing were not
  changed by this CSS/template adjustment.
- After restarting only `codexapp-5900.service`, LAN and StarBridge public checks passed at 375×812
  in light/dark themes, using the actual Codex thread and DSH start page. Codex stayed single-row,
  DSH remained centered, the badge was absent, and switching back restored the Codex route. No DSH
  mutation/model prompt was sent. Screenshots: `output/playwright/workspace-header-production-{lan,public}-{codex,dsh}-{light,dark}.png`; runtime assertions: `output/playwright/workspace-header-production-results.json`.

#### Rollback/Cleanup
- Close the isolated browser contexts. The fixtures write only their browser-local drafts/routes and ignored screenshots.
- To roll back, revert this header commit, rebuild, and restart only the 5900 service. Preserve official Codex, DSH and the existing 5173 server.

---

### Native-only DSH with the shared tool picker

Prerequisites: 4173 belongs to this checkout; the real native DSH bridge is configured for the
workspace check, or native HTTP fixtures are used by the header check. No APK change is required.

1. Run `node scripts/test-workspace-header.cjs` at 320x812, 375x812, 768x1024 and 1280x900,
   light/dark. Codex retains its leading/sidebar/new-chat, Git and terminal controls.
2. Click DSH. The top tool picker remains centered on mobile, with More at the right. The native
   iframe fills the available width and vertical space. There is no outer ACP sidebar/composer,
   duplicate native toolbar or mobile title row; the embedded app owns its own controls.
3. Open More and verify reload/fullscreen/independent-open/theme controls. Switch Codex → DSH
   and verify correct pressed state and restored Codex route, with no model prompts or ACP calls.
4. Run `node scripts/test-dsh-workspace.cjs` to inspect the actual native iframe, not just fixtures.
   Confirm native socket cleanup on leaving, legacy URL redirects and unavailable/retry behavior.

Expected: no overlap/overflow or page errors; only one native status request per entry/reload.
Native DSH's own theme/plugins/history are managed by DSH. Screenshots:
`output/playwright/workspace-header-{320,375,768,1280}-{light,dark}-{codex,dsh}.png` and
`output/playwright/dsh-embedded-{375,768,1280}-{light,dark}.png`.

Cleanup: close browser contexts. No test session/project is created. Rollback by reverting the
native-only entry commit and rebuilding/restarting 5900; preserve DSH and Codex data/config.

Codex compact header regression: with the restored small tool dropdown, a 393x852 browser reports
56 px header height, 36 px picker height, no `has-center` row and the title in the same row.
The prior segmented two-row layout measured 96 px. The production 5900 check saved
`output/playwright/codex-compact-production-mobile.png`; it made no model or ACP requests.
