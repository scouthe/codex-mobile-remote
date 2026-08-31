# Queued timeline does not grow while queue state is polled

### Feature: Repeated queue polling is rendered as one timeline event

#### Prerequisites

- Start the Codex app server and open the web client from a desktop and/or phone.
- Open a thread whose task is idle and whose persisted queue is empty.

#### Steps

1. Send exactly one message while the thread is idle.
2. Keep the thread open for at least 10 seconds while the client polls live task state.
3. Observe the task status at the top of the page and the task timeline.
4. If the message starts running, wait for it to complete and refresh the thread once.

#### Expected Results

- The queue depth reflects the real number of queued messages (one before the task starts, then zero after it drains).
- Repeated polls with the same queue depth do not add more `Queued` timeline rows.
- The timeline does not show an ever-increasing `Queued 1 message` count when only one message was sent.
- After the queue drains, the task returns to the correct running or completed state and remains there after refresh.

#### Rollback/Cleanup

- Allow the task to finish, or use the Stop control to cancel it before testing another thread.
