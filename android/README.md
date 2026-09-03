# Codex Remote (Android)

This Android target is a small native shell around a `codexapp` instance that
runs on your computer. It does **not** install Termux, Node.js, Codex CLI, or a
second app-server on the phone. The computer remains the only Codex writer;
the phone is a remote observer/controller and uses the same task queue,
approval cards, and live-state stream as the web client.

## Architecture

```text
┌──────────────────────────┐       Tailscale Serve (HTTPS)
│ Codex Remote Android     │ ─────────────────────────────────┐
│ Kotlin shell + WebView  │                                  │
│ URL/credential vault    │                                  ▼
└──────────────────────────┘                       ┌────────────────────┐
                                                   │ Computer            │
                                                   │ codexapp bridge     │
                                                   │ ThreadSessionBroker │
                                                   │ Codex app-server    │
                                                   └────────────────────┘
```

The WebView keeps the existing Vue UI and WebSocket/SSE protocol. Native code
adds the pieces that are awkward or unreliable in a browser:

- remembers multiple server addresses and their labels;
- probes LAN, public, and Tailscale addresses in parallel and connects to the
  fastest reachable endpoint on launch;
- stores an optional codexapp password in the Android Keystore;
- restores WebView cookies for a long-lived login session;
- retries after Tailscale/Wi-Fi transitions with bounded backoff;
- opens the Android document picker for file attachments;
- accepts Android share intents and exposes their content to the web UI;
- exposes a small `window.CodexAndroid` bridge for client identity and task
  notifications.

## Build

Requirements:

- Android SDK with API 35 platform/build tools;
- JDK 17 or newer;
- Gradle wrapper (run from this directory).

```bash
cd android
./gradlew assembleDebug
```

The APK is written to
`app/build/outputs/apk/debug/app-debug.apk`. This target does not include a
Termux bootstrap, a bundled server asset, or any local Codex runtime helper.
`app/src/main/assets/` is intentionally empty.

## First launch

1. Start `codexapp` on the computer and expose it through Tailscale Serve, for
   example `https://my-computer.my-tailnet.ts.net`.
2. Open **Codex Remote** and save each address you want to use (for example,
   `http://192.168.1.20:5900`, a public HTTPS URL, and a Tailscale Serve URL).
   Give each address a label so it is easy to identify. A host without a
   scheme is treated as HTTPS.
3. Optionally enter the codexapp password for each address. It is encrypted
   with an AES/GCM key held by Android Keystore; it is never put into the URL.
   Leave it blank when the server trusts the Tailscale identity or when you
   prefer the in-page login form.
4. Tap **Save address**, then **Connect fastest**. On the next launch the app
   probes all saved addresses and selects the one with the lowest response
   latency. A server response such as 401 still counts as reachable; the saved
   password (if present) is applied by the WebView afterward.

Open connection settings at any time to add, edit, use, or delete an address.
The old single-address format is migrated automatically on first launch after
upgrading.

HTTPS is strongly recommended. An explicit **Allow unencrypted HTTP** checkbox
is available for a private test network only; never use it for a forwarded or
public address. The app rejects invalid schemes, URL credentials, query strings,
fragments, and untrusted TLS certificates.

Long-press the connection settings button to forget the URL, encrypted
password, and WebView login cookies.

## Native bridge contract

The current web UI can opt into these methods without requiring a native UI
rewrite:

```js
window.CodexAndroid.getClientInfo()
window.CodexAndroid.openSettings()
window.CodexAndroid.copyText(text)
window.CodexAndroid.setTaskState(state, title, detail)
window.CodexAndroid.clearTaskState()
window.CodexAndroid.getPendingShare()
window.CodexAndroid.readSharedContent(uri)
window.CodexAndroid.clearPendingShare()
```

The activity also dispatches `codex-native-ready`, `codex-native-share`,
`codex-native-network-online`, `codex-native-network-offline`,
`codex-native-pause`, and `codex-native-resume` `CustomEvent`s. The task state
values are the shared observer states (`queued`, `starting`, `running`,
`waiting_approval`, `waiting_user_input`, `steering`, `completed`, `failed`,
and `canceled`).

## Security notes

- The app does not bypass TLS certificate errors.
- The JavaScript bridge is intentionally available only to the configured
  same-origin remote page; do not point the app at an untrusted site.
- A task notification can start a short-lived foreground data-sync service;
  it never executes commands on Android.
- The computer-side app-server still needs its own authentication and safe
  sandbox/approval policy. Tailscale connectivity alone is not a substitute for
  those controls when devices or users are not fully trusted.
