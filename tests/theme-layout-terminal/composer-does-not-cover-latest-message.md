### Composer no longer covers the latest conversation message

#### Feature/Change Name
Thread conversation flex layout reserves the composer area after task timeline rendering.

#### Prerequisites/Setup
1. Build and run this checkout on port 5900 (`pnpm run build` followed by `node dist-cli/index.js --no-login --no-tunnel --no-password --no-open --port 5900`).
2. Open a thread that has a visible task activity timeline (an active or recently completed task) so both the timeline and conversation are rendered.
3. Have a browser or phone viewport available at 375×812 and a desktop/tablet viewport at 768×1024.

#### Automated check

Run `node scripts/verify-composer-layout.cjs`, or set `LAYOUT_TEST_THREAD_ID` to another thread ID before running it. The check captures light and dark screenshots under `output/playwright/` and asserts that the conversation viewport (including the latest message) never extends below the composer top, both before and after a multi-line draft expands the composer.

#### Manual steps
1. At 375×812, open the thread and send a short message while the task is active or immediately after it completes.
2. Confirm the new user message and the current Thinking/activity row remain fully visible above the composer; the conversation may scroll, but the composer must not cover either row.
3. Enter a long multi-line draft so the composer grows, then repeat step 2. Confirm the visible message area resizes and still ends above the composer.
4. Repeat steps 1–3 at 768×1024 and in both light and dark themes.
5. If the on-screen keyboard is available, focus the composer and verify the same no-overlap behavior while the keyboard is open.

#### Expected Results
- The conversation and composer occupy separate vertical regions.
- The latest user message, live Thinking/activity row, and bottom spacing remain visible above the composer at all tested sizes.
- Growing the composer, queue panel, terminal panel, or virtual keyboard does not place conversation content behind it.
- Light and dark themes retain readable borders, text, and backgrounds.

#### Rollback/Cleanup
- Clear the draft and close the thread, terminal, or keyboard panels.
- Remove generated `output/playwright/composer-safe-area-*` screenshots if they are not needed as evidence.
