### Web-created thread remains visible in Codex Desktop

#### Prerequisites

- Start Codex Remote against the same official app-server socket used by Codex Desktop.
- Open Codex Remote on a phone or in the Android app.
- Open the same project directory in Windows Codex Desktop.

#### Steps

1. From the phone client, create a new thread in the shared project and send a unique prompt.
2. Wait for the thread to appear in the Codex Remote sidebar.
3. Refresh or reopen the project conversation list in Windows Codex Desktop.
4. Open the new thread from Desktop and compare its prompt and response with the phone client.
5. Inspect the corresponding row in the Codex state database when diagnosing a failure.

#### Expected Results

- The phone-created thread appears in the Windows Desktop project conversation list.
- Both clients open the same thread ID and show the same prompt and response.
- The thread is created with `history_mode=paginated` and `thread_source=user`.
- Creating the thread adds no extra polling or background requests beyond the existing `thread/start` call.

#### Rollback/Cleanup

- Archive or delete the temporary test thread from either client after verification.

