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

### Shared Codex / DSH header and centered mobile tool switching

#### Feature/Change Name
Both workspaces reuse the same sidebar/new-chat controls. Mobile tool switching uses centered Codex/DSH buttons, with the conversation title on the next row. The former Android-observer/desktop-writer header badge is removed.

#### Prerequisites/Setup
1. Verify that the 4173 listener belongs to this checkout before running `node scripts/test-workspace-header.cjs`.
2. The script intercepts Codex/DSH APIs and streams and simulates the Android bridge. It does not create real sessions or send model prompts.
3. For production checks, use the existing 5900 login. Do not change native DSH or official Codex configuration.

#### Steps
1. At 320×812 and 375×812, open a Codex thread. Verify the leading actions are sidebar and new chat, the Codex/DSH buttons are centered across the full header, and the title appears below.
2. Open the right-hand ellipsis on Codex. Verify the existing Git/review menu is usable. When terminal support is available, its separate button remains visible beside it.
3. Click DSH once. Check that the same leading icons and hit areas stay at the same coordinates, DSH becomes selected, and its own conversation loads. The DSH More menu retains native UI, refresh and appearance actions.
4. Enter a DSH draft, switch Codex → DSH, and verify the draft and last conversation are restored. Open/close the mobile drawer, then use the header new-chat button; it navigates to the DSH start page without creating a Codex thread.
5. At 768×1024 and 1280×900, verify the shared leading controls, tool buttons, truncated title and right-aligned actions. Both desktop sidebars must still open and close.
6. Repeat in light/dark themes. Verify the header, selected tool, icon hover/focus, Git menu and DSH menu use the current theme. Verify no horizontal overflow or Android role badge remains.
7. Run `node scripts/test-dsh-interactions.cjs` for existing approvals, reconnect, history position and per-chat draft behavior.

#### Expected Results
- A single click switches tools using the existing saved workspace routes; clicking the selected tool does nothing.
- Mobile sidebar, new-chat and right action hit areas are 44×44 px. Tool selection has visible pressed state and keyboard focus.
- A long title cannot move the center picker or cover right actions. Desktop keeps its inline title and full Git branch label.
- Removing the role badge changes presentation only; Android observer behavior and native task notifications remain intact.
- The change adds no API, timer, polling, process, database access or history scan. The Codex-only fixture makes zero DSH API requests before explicitly switching.

#### Verification Evidence
- `pnpm run test:unit`: 497 passed, two optional DSH live tests skipped. `pnpm run build` passed.
- `node scripts/test-workspace-header.cjs` passed in all eight viewport/theme combinations. Tool switching, same leading coordinates, mobile centering, Git/DSH menus, drawer, draft restoration and new-chat routing passed with zero model requests/page errors. Each full flow made 46–50 existing API calls, including menu loads and workspace switches.
- The final run also covered long conversation titles and both Codex terminal/Git controls being present at 320px. Neither side overlaps the centered switch.
- `node scripts/test-dsh-interactions.cjs` passed, including existing permission, reconnect, isolated drafts and restored scroll position checks.
- Screenshots: `output/playwright/workspace-header-{320,375,768,1280}-{light,dark}-{codex,dsh}.png`. Tested routes: `http://127.0.0.1:4173/#/thread/00000000-0000-4000-a000-000000000051` and `#/dsh/session/00000000-0000-4000-a000-000000000051`. These are browser/simulated Android checks, not physical APK acceptance.
- The old compact dropdown's event listeners are removed in favor of two buttons using the same existing navigation function. No workspace loading/caching logic changes. The Codex workspace JS shrank from 268.21 kB to 265.74 kB (gzip 75.17 → 74.61 kB); DSH workspace JS is 22.88 kB (gzip 8.73 kB). The largest chunk remains 342.64 kB. Physical Android frame timing was not measured.
- After restarting only `codexapp-5900.service`, LAN and StarBridge public checks passed at 375×812 in light/dark themes, using the actual Codex thread and DSH start page. Both switches were centered, the badge was absent, and switching back restored the Codex route. No DSH mutation/model prompt was sent. Screenshots: `output/playwright/workspace-header-production-{lan,public}-{codex,dsh}-{light,dark}.png`; runtime assertions: `output/playwright/workspace-header-production-results.json`.

#### Rollback/Cleanup
- Close the isolated browser contexts. The fixtures write only their browser-local drafts/routes and ignored screenshots.
- To roll back, revert this header commit, rebuild, and restart only the 5900 service. Preserve official Codex, DSH and the existing 5173 server.

---
