### Conversation prompt navigation rail

The conversation view shows a compact vertical rail for jumping between user
prompts, matching the navigation affordance in the Windows Codex client.

#### Prerequisites

- A running Codex Remote server with a thread containing several user prompts.
- A desktop browser with a mouse or trackpad.

#### Steps

1. Open the thread and confirm the prompt markers are visible along the side of
   the conversation.
2. Hover a marker and confirm an official-style floating card appears beside
   that marker, showing only the user prompt and adapting to the available
   conversation width.
3. Click a marker for an older prompt.
4. Wait for the smooth scroll to settle and confirm the clicked marker remains
   highlighted, even if the viewport is physically closer to the neighbouring
   prompt.
5. Scroll manually and observe that the clicked-marker pin is released and
   the marker nearest the upper portion of the viewport becomes highlighted.
6. With the pointer over a marker, select a different thread from the sidebar.
   Confirm the old prompt card disappears after the new thread loads; move the
   pointer over a new marker to show its prompt card.
7. On a phone-sized viewport, tap a marker once and confirm its prompt preview
   appears without scrolling. Tap it again, or tap the preview, to jump.
8. Repeat in light and dark themes.

#### Expected Results

- One short marker appears for each persisted user prompt currently loaded.
- Hovering or keyboard-focusing exposes a readable, truncated prompt preview
  in a floating card anchored to the selected marker; the card stays within
  the conversation viewport and contains only the user prompt.
- Clicking a marker scrolls that prompt into view without changing the thread
  or loading a different conversation.
- Switching threads clears the previous prompt card and does not show a new
  card until the pointer moves over a marker in the newly selected thread.
- The clicked marker remains active after programmatic navigation until the
  user begins a manual scroll; then the active marker follows the prompt
  nearest the upper portion of the viewport. Marker contrast remains readable
  in both themes.
- Mobile markers retain a compact visual appearance but expose a larger touch
  target, and require preview confirmation before navigation.

#### Rollback/Cleanup

- Switch threads or close the page. No server or client data cleanup is needed.
