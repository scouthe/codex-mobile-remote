### Sidebar thread quick jump

The web client provides a fast path to select a conversation from the sidebar
without manually opening the search control.

#### Prerequisites

- A running Codex Remote server with at least one visible thread.
- Desktop browser or Android WebView with the sidebar available.

#### Steps

1. Press **Ctrl+K** on Windows/Linux or **Cmd+K** on macOS.
2. Confirm the sidebar thread search field opens and receives focus.
3. Type a unique part of a thread title or preview.
4. Press **Enter**.
5. On a mobile viewport, repeat after opening the sidebar drawer if it is
   collapsed.

#### Expected Results

- The thread search field opens without navigating away from the current route.
- Matching threads are filtered in the sidebar.
- Pressing Enter selects the first visible match and navigates to its thread.
- Clicking the search icon continues to open the same search field.

#### Rollback/Cleanup

- Press Escape or clear the search field. No server or client data cleanup is needed.
