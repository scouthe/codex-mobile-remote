# Public relay research

Status: research recorded; implementation deferred

Recorded: 2026-09-02

Target branch: `codexapp/public-relay`

## Goal

Allow the existing `codexapp` service on `127.0.0.1:5900` to be reached through
a user-owned public server and domain, without changing the Windows Codex
Desktop configuration or replacing the official Codex app-server.

The relay is only a network transport layer. The existing web UI, Android app,
task synchronization, official app-server socket, provider configuration, and
Desktop compatibility remain owned by this repository and Codex.

## Current constraints

- Do not change the Windows Codex Desktop connection.
- Do not start a second standalone Codex app-server.
- Continue using the official Codex app-server and shared socket on the Linux
  host.
- Preserve LAN and Tailscale access.
- Support the complete port `5900` traffic surface, including normal HTTP,
  WebSocket (`/codex-api/ws`), SSE (`/codex-api/events`), RPC, file upload, and
  long-running streamed requests.
- Never expose an unauthenticated `--no-password` instance directly to the
  public Internet.

## Candidate projects

The following projects were checked on 2026-09-02. Repository popularity and
activity numbers are intentionally not treated as permanent facts.

| Project | License | Fit for existing port 5900 | Assessment |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) | Apache-2.0 | Excellent | Mature TCP/HTTP/HTTPS reverse proxy with authentication, TLS, reconnect, monitoring, and domain routing. Best first implementation. |
| [rathole](https://github.com/rathole-org/rathole) | Apache-2.0 | Excellent | Lightweight Rust tunnel with mandatory per-service tokens, TLS/Noise, heartbeat, and reconnect. Good lower-resource alternative. |
| [sish](https://github.com/antoniomika/sish) | MIT | Good | SSH-based HTTP(S), WS(S), and TCP tunnelling. Simple for personal use, but less suitable as a managed platform. |
| [chisel](https://github.com/jpillora/chisel) | MIT | Good | TCP/UDP over HTTP/WebSocket with authentication, TLS, keepalive, and reconnect. Functional but less complete than frp for this deployment. |
| [zrok](https://github.com/openziti/zrok) | Apache-2.0 | Good | Self-hostable sharing platform with identity-based public/private sharing. More product-like, but OpenZiti makes deployment substantially heavier. |
| [Pangolin](https://github.com/fosrl/pangolin) | AGPL-3.0 / commercial | Good | Identity-aware reverse proxy and WireGuard platform with SSO/RBAC and automatic HTTPS. Strong multi-user product, excessive for the current personal deployment. |
| [boringproxy](https://github.com/boringproxy/boringproxy) | MIT | Adequate | Web UI and automatic HTTPS for self-hosters, but maintenance activity is weaker than the leading candidates. |
| [nps](https://github.com/ehang-io/nps) | GPL-3.0 | Adequate | Feature-rich, but its license and maintenance profile are less attractive for future commercial packaging. |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 client | Technically good | Client is open source, but the complete server-side relay depends on Cloudflare and cannot be fully self-hosted. |

## Codex-specific projects reviewed

These projects contain useful ideas but are not drop-in network layers for the
current application.

### Codex Relay

[gronxb/codex-relay](https://github.com/gronxb/codex-relay) provides a Codex
mobile companion, pairing, approvals, task steering, and an optional shared
app-server mode. It has its own API and mobile client. Its default mode starts a
private Codex app-server, and its public documentation still expects the phone
to have a LAN or Tailscale path to the local relay. It is useful as a reference
for pairing and mobile interaction, but it does not directly provide the public
relay needed by the existing web application.

### CC Pocket

[heypandax/cc-pocket](https://github.com/heypandax/cc-pocket) includes Android,
iOS, desktop clients, a local daemon, and a self-hostable end-to-end encrypted
relay. It supports Codex along with other coding agents. Its daemon drives its
own Codex app-server subprocess rather than transparently forwarding the
existing `codexapp:5900` service and shared official socket. Adopting it would
replace significant parts of the current architecture and would require new
writer-lock and Desktop synchronization verification.

### Pocket-Codex

[acking-you/pocket-codex](https://github.com/acking-you/pocket-codex) is the
closest Codex-specific public relay design. It can publish an app-server through
`pb-mapper`, offers self-hosted and hosted-account modes, and has a Flutter UI.
The project explicitly describes itself as work in progress and manages or
starts the app-server it exposes. It is a valuable reference for device
discovery and account-scoped relay credentials, but is not yet a stable
drop-in dependency for this repository.

## Recommended first implementation

Use **frp in TCP mode with Caddy as the public HTTPS and authentication
boundary**:

```text
Phone / browser
    |
    | HTTPS / WSS
    v
codex.example.com
    |
    v
Caddy on the public server
    |  TLS termination + user authentication
    v
127.0.0.1:<private-frp-port>
    |
    | frp TCP tunnel
    v
frpc on the Codex Linux host
    |
    v
127.0.0.1:5900 (codexapp)
    |
    v
official Codex app-server shared socket
```

TCP forwarding is preferred for the first version because it transparently
carries HTTP, WebSocket, SSE, uploads, and streamed responses without requiring
the relay to understand Codex or this application's API.

### Security boundary

- `frpc` to `frps` must use a strong token or OIDC and encrypted transport.
- The mapped application port on the public server should bind only to
  `127.0.0.1`, preventing direct access around Caddy.
- Only Caddy should expose ports `80/443` publicly.
- Caddy must enforce an access layer such as strong basic authentication,
  forward authentication, Authelia, or an OIDC provider.
- The public deployment must not forward a passwordless codexapp without the
  outer access layer.
- Logs must avoid request bodies, Codex messages, provider credentials, and
  access tokens.

## Why an application-specific relay is deferred

An integrated commercial relay could later add device pairing, short-lived
tokens, multi-machine discovery, subscriptions, quotas, Android integration,
and end-to-end encryption. It would also require ownership of:

- HTTP, WebSocket, SSE, RPC, upload, and streaming transports;
- authentication, device revocation, and multi-tenant isolation;
- reconnect, replay, heartbeat, backpressure, idempotency, and rate limiting;
- prevention of open-proxy behavior;
- metadata and content privacy, log redaction, abuse handling, and operations.

That work is not necessary to satisfy the current single-user public-access
requirement, so it remains a possible second phase rather than the first
implementation.

## Deferred validation checklist

Before enabling public access, validate all of the following against a real
public server and domain:

1. Normal page load and authentication.
2. WebSocket connection and task progress streaming.
3. SSE fallback, reconnect, and `afterSeq` event replay.
4. Starting, steering, interrupting, and completing a task.
5. Approval and user-input requests.
6. File and image upload, plus project import/export where enabled.
7. Large historical conversation loading.
8. Tunnel interruption, automatic reconnect, and recovery without duplicate
   messages.
9. Windows Desktop and web client synchronization on the same official
   app-server.
10. Confirmation that the private frp port cannot be reached directly from the
    Internet.

## Current decision

No relay implementation is added yet. When work resumes, start with an
independent **frp + Caddy deployment proof**, then decide whether to package
the configuration and systemd units into this repository. Do not build a new
application-level relay unless multi-user, paid-service, or integrated device
management requirements become concrete.
