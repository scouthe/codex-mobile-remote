# Mobile image selection, preview and upload feedback

Prerequisites: run the current Web build; test Android App or a mobile browser at 375×812, and a tablet at 768×1024, in light and dark themes. Sign in and open a test thread. Keep a PNG/JPEG with an extensionless filename available from a document provider.

1. Select an image from the attachment picker. While the upload is pending, expect a visible attaching status and disabled send action.
2. After upload, expect an image thumbnail. Send a prompt and verify the image appears with the sent message.
3. Repeat with an extensionless PNG and empty client MIME metadata. Expect the same thumbnail; the saved path must have an inferred image extension, and preview must return HTTP 200.
4. Simulate an HTTP 413, expired login (401 or HTML login response), unavailable network, and upload timeout. Expect a readable error beside the composer instead of silence; retry with a valid file and verify the old error clears.
5. Simulate a preview HTTP 415 after successful upload. Expect a visible preview failure message, rather than an unexplained broken thumbnail.
6. Attach an ordinary text file. Expect its file chip and an unchanged successful send.

Cleanup: remove the test attachments/drafts. Revert these changes and rebuild to roll back. Automated coverage uses the actual composer with intercepted HTTP responses and an isolated local upload server; physical Android chooser acceptance still requires a device.

Performance verification: one upload request per selected file and the normal preview request; no extra network probe or whole-file copy was added. Server format detection reads a fixed-size byte signature from the existing upload buffer. The existing 25 MiB body cap and 60-second upload timeout remain enforced.
