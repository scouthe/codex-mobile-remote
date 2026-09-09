# StarBridge user client activation

## Prerequisites

- Linux host running `codexapp` on port 5900 with a web password enabled.
- Administrator-issued one-time activation code.
- HTTPS control-plane URL. For LAN-only testing, an RFC1918 HTTP URL such as `http://192.168.1.148:5920` is accepted.
- FRPS OIDC listener reachable by the control plane and the host able to download the pinned FRPC release.

## Steps

1. Open the codexapp web UI and open Settings → Xuanji StarBridge.
2. Enter the control-plane URL, activation code, and an optional device name.
3. Click Activate and wait for the status to become Online.
4. Confirm that the assigned domain is shown, then open that domain from a separate network.
5. Enter a renewal code and click Renew; verify the expiry date changes without changing the domain.
6. Click Restart connection and verify FRPC returns to Online.
7. Click Stop public access and verify the service becomes Stopped while the local 5900 UI remains available.

## Expected results

- The device secret and FRPC configuration are written only on the Linux host with mode `0600`.
- The browser never receives the device secret or the FRPC configuration.
- FRPC is managed by a systemd user unit when available, with a detached process fallback on minimal Linux.
- Invalid, expired, or reused codes produce an actionable error and do not overwrite the last working configuration.

## Cleanup / rollback

- Use Stop public access to disable the FRPC process.
- Remove `~/.config/codexapp/starbridge` (or `CODEXUI_STARBRIDGE_HOME`) only when intentionally revoking the local device credentials.
- Revert the feature commit to remove the UI and routes; the existing Codex app-server remains unaffected.
