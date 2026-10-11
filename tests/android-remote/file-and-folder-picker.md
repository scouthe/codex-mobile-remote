# Android photo, file and folder selection

Prerequisites: install the 0.3.1 APK or newer over the existing App; deploy matching Web code. Prepare a PNG/JPEG, a text file, and a folder with nested image/text files in Android shared storage. Test the production composer in light/dark themes at 375×812 and 768×1024. Only user-selected document URIs are read; no broad storage permission is required.

1. Open an existing thread. Tap “Add photos & files”, choose one image, and return. Expect a thumbnail, uploading status while pending, and one submitted image after send. Repeat with multiple images and a mixed image/text selection. Providers returning only ClipData must work even for one image.
2. Tap “Take photo”. Expect the existing single-URI photo path to keep working. Cancel either picker and verify no stale selection is attached.
3. Tap “Add folder”. Expect Android's system directory picker. Choose the prepared folder and authorize access. Expect a folder chip, image thumbnails, preserved relative text-file labels, and a disabled send action until all uploads finish. Send and verify imageUrls contains the images and fileAttachments contains the text files.
4. Remove one image thumbnail and verify its folder file count decreases. Remove a completed folder chip and expect its remaining images and text attachments to disappear. Retry a folder with an upload failure; expect the error to be visible, progress to finish, and a later successful selection to clear the error.
5. While a request is pending, switch to another thread/draft. Expect the late result to be discarded. On an older APK, “Add folder” should explain that an App update is required.
6. Choose an empty, inaccessible or excessively large folder. Expect a native message. Enumeration runs off the UI thread and is bounded to 200 files, 1,024 directories, 20 MiB per file and 40 MiB known aggregate size; the existing share reader also checks actual bytes.

Automated coverage: Robolectric uses real Intent/ClipData objects for single, multiple and canceled results, and a synthetic DocumentsProvider for nested folders, cycles, limits and metadata. The composer fixture verifies real rendering/submission, pending-send protection, stale results, removal, failures and retry. No physical Android device was connected; gallery/provider acceptance remains a phone check.

Performance: directory enumeration reads metadata once per directory plus the root, never reads file bytes during enumeration, and stops at the bounds above. Folder uploads remain sequential, with one upload per file and preview requests only for images. Robolectric is a test-only dependency and is absent from the APK.

Cleanup/rollback: remove test drafts and uploaded files if desired. Reinstall the prior signed APK and rebuild the previous Web commit to roll back. An update preserves configured connection addresses and credentials; do not uninstall first.
