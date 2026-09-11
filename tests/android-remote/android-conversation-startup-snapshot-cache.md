### Feature: Android conversation startup snapshot cache

#### Prerequisites

- A 5900 server built from the current branch and reachable from an Android
  WebView.
- The Android app configured with a server profile and at least one thread that
  has already been opened once.

#### Steps

1. Open a thread in the Android app and wait until its messages are visible.
2. Fully close the app, then open it again without clearing app data.
3. Confirm the last cached messages appear before the network refresh finishes.
4. Send or receive a new message from another client, then reopen the same
   thread. Confirm the server version replaces the stale snapshot.
5. Open the settings panel and tap **Clear App conversation cache**. Reopen a
   thread and confirm it loads from the server again.
6. Open the same server URL in a normal browser. Confirm the browser does not
   restore the Android snapshot or show the Android-only cache control.

#### Expected Results

- The Android app can paint the most recently cached bounded conversation
  without waiting for a complete `thread/read` request.
- `sessionRevision` changes cause a server refresh; cached data never replaces
  newer server messages or task state.
- The cache is isolated by server origin and stores no passwords, tokens, or
  optimistic messages.
- Ordinary browser clients retain their existing network-loading behavior.

#### Rollback/Cleanup

- Use **Clear App conversation cache** to remove snapshots for the current
  server origin.
- Do not clear Android app data unless removing saved connection profiles is
  also intended.
