### Feature: Fast snapshot hydration preserves canonical message order

#### Prerequisites

- Start codexapp against the shared Codex app-server socket.
- Use a persisted thread whose latest 10 turns contain more than 50 rendered rows, including command executions or failed turns followed by a final assistant response.
- Open the same thread in Desktop and a 375×812 browser or Android WebView.

#### Steps

1. Open the thread route on the mobile client and confirm the bounded fast snapshot paints the latest assistant response.
2. Wait at least five seconds for the background `thread/read` hydration to finish.
3. Confirm the same final assistant response remains visible at the bottom without using **Load earlier messages**.
4. Compare repeated user prompts and assistant responses before and after hydration.
5. Refresh the route and repeat the check once.

#### Expected Results

- Background hydration keeps the canonical order returned by `thread/read`.
- Newly hydrated command, file-change, and error rows remain before the final assistant response from their turn.
- Fast-session event rows and their persisted response items are not rendered as duplicates.
- A bounded tail whose absolute turn offset is unknown does not expose fabricated turn indexes.
- The latest assistant response remains in the default 50-row render window.

#### Rollback/Cleanup

- No persistent test data is created; close the test browser when finished.
