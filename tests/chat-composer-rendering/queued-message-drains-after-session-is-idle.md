# Queued message drains after the session becomes idle

### Feature: A stale active projection cannot keep an idle thread queued

#### Prerequisites

- Start the Codex app server with the shared session directory available.
- Open the same thread in the desktop Codex client and the web client.
- Have the thread complete a task, then leave it idle before testing.

#### Steps

1. Confirm the desktop task has finished and the thread shows no active request.
2. From the phone/web client, send exactly one normal message.
3. If the client briefly shows `Queued`, keep the thread open for at least 10 seconds.
4. Observe the queue row, task activity card, and conversation messages.

#### Expected Results

- The message is processed automatically once the shared session is idle; no manual resend is required.
- The queue depth returns to zero and the queued row is removed after the turn starts.
- A stale `thread/read` status of `inProgress` does not cause the queue to retry forever when the session log already contains a terminal marker.
- The task card changes from `Queued` to `Thinking`/activity and then `Completed` (or a clear failure), with the assistant result visible on both clients.

#### Rollback/Cleanup

- If a test turn fails, use the existing retry or Stop control and remove any test-only message from the thread if needed.
