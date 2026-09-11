### Feature: Mobile task timeline collapses repeated activity

#### Prerequisites

- A running Codex Remote server and an Android WebView or 375×812 browser
  viewport.
- A thread that runs a command or produces streamed assistant output.

#### Steps

1. Open the active thread on a narrow mobile viewport.
2. Start or observe a task that emits command output deltas.
3. Confirm the top task timeline shows one compact current-status row rather
   than a row for every output delta.
4. Tap the current-status row. Confirm the historical activity list expands;
   repeated adjacent activities appear as one row with a repeat count when
   applicable.
5. Switch to a desktop-width viewport and repeat the check in both light and
   dark themes.

#### Expected Results

- Mobile shows the current task state without pushing the conversation below
  the fold.
- Command output remains available through the existing expandable command
  rows, not duplicated in the timeline.
- Desktop retains its normal visible timeline history, and both themes keep
  readable borders, text, and hover states.

#### Rollback/Cleanup

- Stop the test turn. No server or client data cleanup is required.
