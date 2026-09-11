### Conversation prompt navigation rail

The conversation view shows a compact vertical rail for jumping between user
prompts, matching the navigation affordance in the Windows Codex client.

#### Prerequisites

- A running Codex Remote server with a thread containing several user prompts.
- A desktop browser with a mouse or trackpad.

#### Steps

1. Open the thread and confirm the prompt markers are visible along the side of
   the conversation.
2. Hover a marker and read its tooltip.
3. Click a marker for an older prompt.
4. Scroll manually and observe which marker is highlighted.
5. Repeat in light and dark themes.

#### Expected Results

- One short marker appears for each persisted user prompt currently loaded.
- Hovering exposes a readable, truncated prompt preview.
- Clicking a marker scrolls that prompt into view without changing the thread
  or loading a different conversation.
- The active marker follows the prompt nearest the upper portion of the
  viewport; marker contrast remains readable in both themes.

#### Rollback/Cleanup

- Switch threads or close the page. No server or client data cleanup is needed.
