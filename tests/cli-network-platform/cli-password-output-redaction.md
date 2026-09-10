### First-run web password choice and CLI password redaction

#### Feature/Change Name
Fresh installations choose password-protected or LAN-only access in the browser. Stored passwords remain stable across restarts, while CLI output never prints a configured password or embeds it in a tunnel URL.

#### Prerequisites/Setup
1. Project dependencies are installed.
2. CLI build is available from the current branch.

#### Steps
1. Run `pnpm run build:cli`.
2. Set `CODEX_HOME` to a new disposable directory and start the CLI without `--password` or `--no-password`.
3. Open the printed local URL. Confirm that the first-run page offers “Set password and continue” and “Not now, LAN only”, and clearly says that public remote access requires a password.
4. Enter mismatched passwords and confirm that the page stays open with an error. Then enter the same 8–128 character password twice and submit.
5. Confirm the app opens, `codexui-password` exists with `0600` permissions, and restarting with the same `CODEX_HOME` accepts the same password without showing first-run setup again.
6. Repeat with another disposable directory, choose LAN-only, and confirm `codexui-password-skipped` exists with `0600` permissions.
7. Confirm localhost and a private LAN address can open the app, while a request arriving through a public host/reverse proxy receives HTTP 403. Confirm StarBridge reports that password protection is disabled.
8. In the LAN-only app, open Settings → Web access password. Set and confirm a new password, then verify StarBridge immediately reports password protection enabled and the current browser remains signed in.
9. Reopen the same settings panel while protected and confirm it supports changing the password.
10. Start the CLI with a disposable explicit password: `node dist-cli/index.js --no-tunnel --no-open --port 5998 --password TEST_SECRET_SHOULD_NOT_PRINT`.
11. Confirm startup output includes the local and network URLs but does not include `Password:` or `TEST_SECRET_SHOULD_NOT_PRINT`.
12. If tunnel testing is available, start with tunnel enabled and confirm the printed tunnel URL and QR code do not include `/password=`.

#### Expected Results
- Password-protected startup still works.
- A fresh default startup does not expose the Codex UI until the local user makes an explicit choice.
- Password setup takes effect immediately and persists across restarts.
- LAN-only mode cannot be reached through a public reverse-proxy host and cannot enable StarBridge.
- A LAN-only user can enable password protection later without restarting the server.
- The password is not printed as a standalone line.
- Existing password files remain compatible and are no longer overwritten on restart.
- Tunnel output does not include an autologin URL containing the password.

#### Rollback/Cleanup
- Stop the disposable CLI process.
- Delete only the disposable `CODEX_HOME` directories created for this test.

---
