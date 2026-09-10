# StarBridge user client activation

## Prerequisites

- Linux host running `codexapp` on port 5900 with a web password enabled.
- Administrator-issued one-time activation code.
- The built-in control plane (`https://auth.xingqiao.xuanjishu.site`) is reachable. For a private deployment, set `CODEXUI_STARBRIDGE_CONTROL_URL` on the Linux host before starting codexapp.
- FRPS OIDC listener reachable by the control plane and the host able to download the pinned FRPC release.

## Steps

1. Open the codexapp web UI and open Settings → Xuanji StarBridge.
2. Confirm that the activation form contains only one user-editable field: Activation code. Control-plane URL and device-name fields must not be shown.
3. Enter the administrator-issued activation code. The client uses the built-in control-plane URL and derives the device name from the Linux hostname.
4. Click Activate and wait for the status to become Online.
5. Confirm that the complete assigned HTTPS URL is shown as a link, its copy button returns the same URL, and the link opens from a separate network.
6. Enter a renewal code and click Renew; verify the expiry date changes without changing the domain.
7. Click Restart connection and verify FRPC returns to Online.
8. Click Stop public access and verify the service becomes Stopped while the local 5900 UI remains available.

## Expected results

- The device secret and FRPC configuration are written only on the Linux host with mode `0600`.
- The browser never receives the device secret or the FRPC configuration.
- FRPC is managed by a systemd user unit when available, with a detached process fallback on minimal Linux.
- Invalid, expired, or reused codes produce an actionable error and do not overwrite the last working configuration.
- The browser sends only the activation code to the local bridge. It does not choose the control plane or device identity.

## Cleanup / rollback

- Use Stop public access to disable the FRPC process.
- Remove `~/.config/codexapp/starbridge` (or `CODEXUI_STARBRIDGE_HOME`) only when intentionally revoking the local device credentials.
- Unset `CODEXUI_STARBRIDGE_CONTROL_URL` after private-control-plane testing to restore the built-in production endpoint.
- Revert the feature commit to remove the UI and routes; the existing Codex app-server remains unaffected.
