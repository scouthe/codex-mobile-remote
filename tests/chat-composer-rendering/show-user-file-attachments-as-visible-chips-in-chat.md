### Feature: Show user file attachments as visible chips in chat

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open any thread with an active composer.
- Have at least one local file available to attach.

#### Steps
1. Attach one or more files via composer (file picker, paste long text as `.txt`, or other file attachment flow).
2. Send the message.
3. Locate the sent user message in conversation.
4. Verify file attachment chips are rendered above message text.
5. Click a file chip and confirm it opens the browse URL in a new tab/window.
6. Right-click the chip link and verify file-link context actions still appear (`Open link`, `Copy link`, and `Edit file` when applicable).
7. Upload a file smaller than 25 MB and confirm it attaches normally. Try a multipart request larger than 25 MB, including one sent without `Content-Length`, and confirm HTTP 413 without a saved file.

#### Expected Results
- Sent user messages with `fileAttachments` show visible file chips in chat.
- Chip labels match attachment labels from composer payload.
- Chip links resolve through browse URLs and remain clickable.
- Existing file-link context menu behavior works on the chip links.
- The upload endpoint limits each multipart request body to 25 MB; oversized requests do not exhaust process memory.

#### Rollback/Cleanup
- Close any opened file tabs and remove temporary test messages if needed.
