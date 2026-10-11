### Feature: Android bounded endpoint selection

#### Prerequisites

- Build the Android app with `cd android && ./gradlew testDebugUnitTest assembleDebug`.
- Use an emulator or test phone with two or more saved test addresses. Do not
  alter the live port 5900 service or use incorrect passwords against it.
- Prepare isolated HTTP test endpoints: a fast Codex `/auth/status` JSON or
  login response, a response delayed for at least 5 seconds, an immediate 502,
  a generic 403, and a 403 containing the Codex login form. For private HTTP
  endpoints, explicitly enable the existing Allow unencrypted HTTP option.

#### Steps

1. Save a fast test Codex address and the delayed address. Tap Connect fastest.
   Measure from tap to the start of WebView navigation; it should not await the
   5 second endpoint. A candidate starts a 120 ms window, then the fastest
   usable response received during that window wins.
2. Add the immediate 502 and generic 403. Repeat selection. Neither error page
   should beat a usable Codex address, even if it responds sooner.
3. Select an endpoint returning the actual Codex login page with status 200 or
   403, then one returning 401. Confirm these remain eligible and proceed to
   normal WebView authentication. Do not submit intentionally incorrect passwords.
4. Probe the Codex LAN-only public-access denial. Confirm this 403 is excluded.
   Also check an unrelated HTTP 200 page is excluded.
5. Make every test address stall. Within the 3 second total selection budget
   (plus normal UI scheduling), the editable address configuration should return
   with the existing no-reachable-server message.
6. Start selection, open settings or choose another saved address, then let the
   previous delayed endpoint reply. The stale result must not replace the chosen
   page. Repeat quickly and rotate/close the activity: there must be at most one
   selection callback per run and no late navigation after cancellation.
7. Repeat steps 1 and 5 in light and dark Android themes; the existing selection,
   error and saved-address controls must remain readable. No layout changes are
   expected from this feature.

#### Expected Results

- One lightweight `/auth/status` probe per saved candidate, no probe passwords,
  and no `/codex-api/app-server/status` traffic from selection.
- Up to 16 candidates start in parallel; a blocked DNS lookup does not hold the
  completion timer. A response is inspected only up to 16 KiB.
- A fast success incurs at most the additional 120 ms race window, and all
  failures finish by the 3 second budget. An all-completed race finishes early.
- Outstanding work is interrupted/disconnected off the main thread; canceled
  queued work and late callbacks cannot affect subsequent selections.
- Existing WebView cookies, saved-password submission, profile editing and
  manual address selection remain available.

#### Automated Evidence

The JVM suite exercises a 50 ms success against stalled alternatives (selection
at 170 ms virtual time), near-simultaneous lower-latency competitors, 16 stalled
workers (completion at 3000 ms), failed proxies, all-failure handling, generation
replacement and cancellation. Local ephemeral HTTP fixtures verify auth-status
requests, no password transmission, login/denial discrimination and response caps.

#### Rollback / Cleanup

- Remove only the test address profiles and stop the isolated mock endpoints.
- No server configuration, production authentication state or official Codex
  state needs to change. Reinstall the previous APK if reverting the client.
