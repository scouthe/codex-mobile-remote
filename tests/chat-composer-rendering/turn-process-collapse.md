# Turn process collapse and final answer boundary

## Prerequisites

- Open a thread with a completed turn containing commentary, commands, and a final answer.
- Have a large thread that initially loads through `/codex-api/thread-fast-state`.
- Test light and dark themes at desktop, 375×812, and 768×1024 widths.

## Steps

1. Open the completed thread. Locate the line above its final answer showing the turn duration.
2. Confirm commentary and command rows are hidden by default, while the final answer, user prompt, and any turn error remain visible.
3. Expand the duration line, inspect the commentary and command details, then collapse it again.
4. Refresh the large thread and repeat steps 1–3 before full history hydration. Check a legacy assistant message with no phase marker remains visible.
5. While a new turn streams, confirm interim commentary stays behind the expandable working line, no duplicate `Thinking` row appears below it, and a final answer appears outside it. Retry and error actions must remain visible.
6. On narrow screens, confirm the right-side prompt navigation does not cover the answer or the duration line.
7. Reopen the same completed thread in the Android app after upgrading the web assets; its previously cached messages should refresh once and then use the same folded layout.

## Expected results

- Each turn has at most one process summary. Expanding it restores the original process messages without changing their content.
- The final answer is always visible and separate. Copying it does not include commentary.
- Unknown-phase assistant messages are not collapsed, and no new API requests are caused by expanding a process summary.

## Cleanup

- Collapse any expanded summaries. No thread or server state is changed by this display-only test.
