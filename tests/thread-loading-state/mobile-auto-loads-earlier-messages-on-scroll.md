### Mobile conversation auto-loads earlier messages

On a phone-sized viewport, scrolling to the top of a conversation automatically
loads older messages instead of requiring a **Load earlier messages** tap.

#### Prerequisites

- A running Codex Remote server with a thread containing more than the initial
  rendered message window.
- Android WebView or a 375×812 browser viewport.

#### Steps

1. Open the thread and wait for the latest messages to render.
2. Swipe downward repeatedly (scroll upward through the conversation) until
   the list reaches the top.
3. Keep the list at the top while the older page loads.
4. Repeat until the beginning of the conversation is reached.

#### Expected Results

- Older messages load automatically when the top threshold is reached.
- On Android, cached history is revealed first when available, reducing network
  round trips; subsequent pages request up to 30 turns at once.
- The scroll position remains anchored around the messages already visible;
  the viewport does not jump to the bottom.
- A loading state prevents duplicate requests while one older page is pending.
- Desktop deferred-observer sessions retain their explicit load action.

#### Rollback/Cleanup

- Stop scrolling or switch threads. No server or client data cleanup is needed.
