### Feature: Linux one-click installer

#### Prerequisites

- Linux host with Node.js 18+ and the official `codex` command available in `PATH`.
- A release archive, or network access to the GitHub Release asset.
- Existing `~/.codex` configuration should be backed up before a production upgrade.

#### Steps

1. Download `install.sh` from the project's GitHub Release and inspect it.
2. Run `bash install.sh` (or set `CODEXAPP_ARCHIVE` for an offline archive).
3. Open the printed `http://127.0.0.1:5900` or LAN URL.
4. Complete first-run password setup in the browser.
5. Open Settings → StarBridge and enter an administrator-issued activation code.
6. Verify the StarBridge status becomes online and open the assigned HTTPS domain.

#### Expected Results

- The `codexapp-5900.service` user unit is running and the web page loads without a
  source checkout or pnpm build.
- The existing `~/.codex` files and official app-server configuration are unchanged.
- A valid activation code configures FRPC through the existing StarBridge flow and
  exposes the assigned public address.
- An invalid code is reported in the StarBridge panel without changing Codex state.

#### Rollback/Cleanup

```bash
systemctl --user disable --now codexapp-5900.service 2>/dev/null || true
rm -rf "$HOME/.local/share/codexapp" "$HOME/.local/bin/codexapp" \
  "$HOME/.config/systemd/user/codexapp-5900.service"
```

The cleanup above does not remove `$CODEX_HOME` or any official Codex files.
