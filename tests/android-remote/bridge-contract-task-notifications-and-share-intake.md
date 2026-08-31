### Feature: Android bridge contract, task notifications, and share intake

#### Prerequisites

- JDK 17, Android SDK 35, and an API 24+ device or emulator.
- A desktop `codexapp` server built from this branch and reachable from the
  device (Tailscale HTTPS is recommended).
- The Android APK installed from `android/app/build/outputs/apk/debug/app-debug.apk`.
- The web UI build includes the `src/native/codexAndroid.ts` adapter and its
  bridge consumer.

#### Steps

1. Connect the app to the server and open an existing thread. In WebView
   DevTools, verify `window.CodexAndroid.getClientInfo()` returns JSON with a
   non-empty `clientId`, `clientType: "android"`, and `mode: "remote-observer"`.
2. Reload the page and call `getClientInfo()` again. Confirm the `clientId` is
   unchanged across the reload (and after a full app restart).
3. Start a long-running turn from the desktop or Android UI. Verify the web
   consumer maps its lifecycle to native task states in this order as events
   arrive: `queued`/`starting` → `running` (or `steering`) → `completed`,
   `failed`, or `canceled`.
4. Put the app in the background while the turn is running. Confirm a native
   notification appears when notification permission is granted. On Android
   13+, deny notification permission once and confirm the app remains usable;
   no repeated permission-dialog loop should occur.
5. Tap **Stop monitoring** on an in-progress notification. Confirm only the
   local notification is dismissed; the remote turn is not implicitly
   interrupted. Reopen the app and verify the shared thread state is still
   authoritative.
6. From another Android app, share plain text to Codex Remote. Confirm one
   `codex-native-share` event is delivered and the text appears in the active
   composer. Reopen the app or deliver a second share and confirm each intent
   is delivered once.
7. Share one small text file and one image. Confirm each URI appears as an
   attachment candidate with its display name and MIME type, and that the web
   consumer calls `readSharedContent(uri)` only for the selected attachment.
8. Share a file larger than 20 MiB. Confirm the consumer reports the native
   `file-too-large` error without freezing the WebView or sending a partial
   upload.
9. Disconnect Wi-Fi/Tailscale briefly, then reconnect. Confirm the app emits
   the online/offline lifecycle events, reconnects its WebSocket/SSE stream,
   and does not issue a duplicate `thread/resume` for the same thread.
10. Open a link to a different host from the conversation. Confirm it opens in
    the system browser while the configured server remains the only WebView
    origin.

#### Expected Results

- The bridge is optional: the same Vue build still works in a normal browser
  where `window.CodexAndroid` is absent.
- Unsupported task states are ignored; `cancelled` is normalized to the
  canonical `canceled` state before notification dispatch.
- Client identity and observer mode are exposed consistently, while actual
  thread data and writer coordination remain server-authoritative.
- Share events are not duplicated, malformed payloads are ignored safely, and
  shared bytes are bounded by the native 20 MiB limit.
- Network/lifecycle transitions recover the read-only snapshot and event stream
  without creating a competing app-server writer.

#### Rollback/Cleanup

- Stop any active turn and remove the temporary Android app/data if this was a
  device-only verification.
- Clear the saved server profile with the settings button's long press.

