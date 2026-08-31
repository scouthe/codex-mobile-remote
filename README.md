# 📱 Codex App Remote

Codex App Remote is a native Android client for a `codexapp` instance running
on your computer. The computer remains the only Codex execution host; the
phone is a lightweight observer/controller that connects over HTTPS (usually
through Tailscale).

This project is based on the MIT-licensed `codex-mobile` application shell and
the shared-observer work in this fork. It is intended for personal, self-hosted
use. The Android app does **not** install Termux, Node.js, the Codex binary, or
a second app-server.

## What it does

- Saves a remote `http(s)` endpoint and reconnects on launch.
- Opens the existing Codex UI in a hardened WebView.
- Identifies itself as an Android observer so the desktop remains the writer.
- Shows the desktop's existing threads and live task state.
- Supports queued messages, steer, interrupt, approvals, and user-input
  requests when the connected server exposes those shared-observer APIs.
- Reconnects after a temporary Wi-Fi/Tailscale interruption without starting a
  second `thread/resume`.
- Provides Android-native notifications, clipboard integration, file chooser,
  share-sheet intake, dark mode, and system back navigation.

The UI, queue, and Codex protocol continue to live in the web/server project;
the Kotlin layer supplies lifecycle, networking, credentials, and Android
integration.

## Architecture

```text
┌──────────────────── Android APK ────────────────────┐
│  Kotlin activity + WebView                          │
│  • endpoint/password storage (Android Keystore)     │
│  • lifecycle and network reconnect                  │
│  • notifications, files, share sheet, clipboard     │
└────────────────────────┬───────────────────────────┘
                         │ HTTPS / Tailscale
                         ▼
┌────────────── computer ──────────────┐
│ codexapp bridge (:5900 or configured) │
│ shared observer + task queue          │
│             │                         │
│             ▼                         │
│       Codex app-server                │
│       (唯一执行端 / single writer)    │
└───────────────────────────────────────┘
```

The app sends `X-Codex-Client-Type: android` and
`X-Codex-Client-Mode: observer` on the initial navigation. A saved client ID
is exposed to the page for task/writer status and remains stable across app
restarts.

## Run the desktop server

On the computer that owns the Codex installation:

```bash
git clone https://github.com/scouthe/codex-mobile-remote.git
cd codex-mobile-remote
git switch android-remote-client

pnpm install
pnpm run build:frontend
pnpm run build:cli
node dist-cli/index.js --port 5900 --no-open --no-tunnel
```

The server needs access to the computer's Codex CLI and its existing
`CODEX_HOME` authentication. Keep the server bound behind Tailscale or another
private network. If you use Tailscale Serve, expose the local port rather than
opening port 5900 on the public Internet:

```bash
tailscale serve --https=443 http://127.0.0.1:5900
```

Use the resulting HTTPS hostname in the Android app. A local Wi-Fi URL such as
`http://192.168.1.20:5900` is also accepted after explicitly enabling the
“Allow HTTP” option, but HTTPS is recommended.

## Build the Android app

### Prerequisites

- Android Studio or Android SDK command-line tools;
- JDK 17;
- Android SDK platform 35 and build tools installed;
- Node.js 18+ and pnpm (needed only for the frontend/CLI verification build);
- an Android 7.0 (API 24) or newer device/emulator.

The remote client has no native Codex executable and does not require an ARM64
device or a Termux bootstrap archive.

```bash
git clone https://github.com/scouthe/codex-mobile-remote.git
cd codex-mobile-remote
git switch android-remote-client

pnpm install
pnpm run build:frontend
pnpm run build:cli

cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. CI additionally publishes
it as `codexapp-remote.apk` under the `codexapp-remote` artifact name.

For a signed release build, configure your normal Android signing credentials
and run `./gradlew assembleRelease`.

## First launch

1. Enter the computer's Tailscale HTTPS URL (or a trusted LAN HTTP URL).
2. Enter the codexapp password if the server requires one. Tailscale ACLs can
   provide the network boundary, but they do not automatically disable the
   app-server's own authentication.
3. Tap **Connect**. The URL and password are retained for the next launch;
   the password is encrypted with an Android Keystore AES-GCM key.
4. The app opens the existing desktop threads. It does not create a second
   local Codex session.

If the server is busy, the phone remains an observer. A normal message can be
queued, **Steer** sends guidance to the current turn, and **Stop** requests an
interrupt. The exact controls depend on the server-side shared-observer build.

## Security notes

- Prefer Tailscale HTTPS or another authenticated private network.
- Do not expose `--no-password` over a public interface.
- Use `--no-password` only on a network you fully trust and understand.
- The Android WebView rejects navigation to a different host, port, or scheme
  and cancels TLS certificate errors.
- Clear saved credentials with the settings button's long-press action.
- The server still has the permissions of the local Codex process. Review its
  sandbox and approval policy before enabling unattended execution.

## Development notes

The Android shell is intentionally small. Changes to conversation rendering,
live events, task queues, writer coordination, and approvals belong in `src/`
and are consumed by the remote WebView. Kotlin changes should remain focused
on:

- lifecycle and network callbacks;
- secure endpoint/password storage;
- WebView navigation and file/share bridges;
- notification updates and Android permissions.

The old local-runtime helpers (`BootstrapInstaller`, `CodexServerManager`, and
their assets) are retained in the source tree for migration/reference. They are
not started by the remote activity or required by the remote CI workflow.

## Troubleshooting

### The app cannot connect

- Verify the desktop process is listening on the configured port.
- Test the exact HTTPS URL from another device on the same Tailscale network.
- Check Tailscale ACLs and `tailscale serve status`.
- For an HTTP LAN URL, enable **Allow HTTP** in the connection form.

### The app asks for a password

This is the desktop server's authentication, not Android's Wi-Fi password. Set
the codexapp password in the app, or configure authentication at the private
network layer and use the server's documented trusted-network option.

### Progress stops after the phone sleeps

Reopen the app. The WebView reconnects with the same observer client ID and the
server replays the available live events. Long-running execution continues on
the computer even while the phone is offline.

## License

MIT. See [LICENSE](./LICENSE).
