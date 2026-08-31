# Idle session sends directly

### Feature: A stale browser activity flag cannot force an idle session into the queue

#### Prerequisites

- Start the latest Codex web service and open a thread from both desktop and phone.
- Finish any desktop task and wait until the session is idle.
- Leave the phone page open long enough for its cached status to become stale.

#### Steps

1. Confirm there is no active turn or pending approval in the desktop client.
2. Send one normal message from the phone client.
3. Observe the network/task status and wait for the assistant response.

#### Expected Results

- The phone sends `turn/start` directly when the shared session marker is idle.
- The message does not appear as a queued row merely because the browser held an old `inProgress` flag.
- If the session becomes active between the status check and send, the existing writer-conflict recovery may queue the message; otherwise an idle session starts immediately.

#### Rollback/Cleanup

- Let the response finish before sending another message, or use Stop if the test prompt intentionally starts a long task.
