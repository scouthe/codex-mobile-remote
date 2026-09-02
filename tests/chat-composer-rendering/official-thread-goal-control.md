# Official thread goal control

## Feature: Goal button uses the Codex app-server Goal API

#### Prerequisites

- Start codexapp against the official Codex app-server.
- Confirm the server exposes `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear` in `/codex-api/meta/methods`.
- Open the same existing thread in two browser clients (or in the web client and Codex Desktop).

#### Steps

1. In the web client, open an existing thread and open the `+` composer menu.
2. Select `Goal`, enter a short objective, and choose `Save goal`.
3. In the second client, remain on the same thread and wait for the shared event stream to deliver the update.
4. Edit the objective from either client and confirm the other client updates without a page refresh.
5. Open the Goal dialog again and confirm the official status and usage/time values are displayed when present.
6. Choose `Clear goal` and confirm the goal is removed in both clients.

#### Expected Results

- The Goal entry appears only for an existing thread, alongside Plan mode in the composer menu.
- Saving and clearing call the official `thread/goal/*` RPCs; they do not start a turn, enqueue a message, or change the writer/observer state.
- Goal updates and clears converge in both clients through the existing notification stream.
- If the connected Codex version does not expose Goal RPCs, the entry is disabled with a clear unsupported-version message.
- The dialog remains usable at 375×812 and 768×1024 in both light and dark themes.

#### Rollback/Cleanup

- Clear the test goal after verification. No thread history or task output is created by this feature.
