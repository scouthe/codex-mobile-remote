### Android cache byte budget and completeness

#### Feature/Change Name
Bound Android conversation snapshots in one pass with a 4 MiB UTF-8 JSON budget, retain at most 200 persisted messages, and distinguish pageable older turns from incomplete retained content.

#### Prerequisites/Setup
1. Use an isolated test server and Android WebView with the native bridge available. Do not restart the persistent server or change the user's Codex configuration.
2. Prepare completed test conversations containing: more than 200 persisted rows across separate turns; a single turn with more than 200 rows; a message longer than 64,000 characters; and enough Chinese/emoji text to exceed 4 MiB.
3. Open WebView remote debugging, including Network and IndexedDB (`codex-remote-android`, `conversation-snapshots`). The cache format version is 3.

#### Steps
1. Open the multiple-turn conversation, load enough older messages to exceed 200 rows, and wait at least 350 ms for the cache write.
2. Inspect its stored record. Measure `new TextEncoder().encode(JSON.stringify(record)).byteLength`; count `record.messages`; check `hasMoreOlder` and `requiresHydration`.
3. Reload into another conversation, wait for the notification stream to connect, then open the cached conversation without changing its server revision. Scroll to the oldest cached row and load older messages.
4. Repeat with the single-turn conversation and oversized text. After reloading into another conversation and returning, verify server hydration occurs despite the unchanged revision, and the retained conversation text is complete after hydration.
5. Repeat with Chinese/emoji text. Confirm the complete stored record, including metadata, stays within 4,194,304 UTF-8 bytes.
6. With the server temporarily unreachable in this isolated setup, open an incomplete cached conversation, then restore connectivity and retry. Confirm a failed hydration does not make the truncated cache authoritative.
7. Open the same thread ID through a second test origin. Confirm the first origin's snapshot is not read. Clear Android cache on the second origin, then verify the first origin's record remains available.
8. Open the app in an ordinary browser without `CodexAndroid`; confirm conversation cache operations remain disabled.

#### Expected Results
- At most 200 non-optimistic messages are cached in their original order, as a contiguous suffix.
- The entire stored JSON record uses at most 4 MiB in UTF-8, including multibyte characters and JSON escaping. A single oversized metadata field cannot bypass this limit.
- Removing complete older turns sets `hasMoreOlder: true`; intact retained rows can still be reused and older turns paginated normally.
- Cutting within a turn or clipping text/raw payload/command output sets `requiresHydration: true`. Matching revisions do not suppress the required server hydration.
- Version 2 records are ignored because they lack reliable completeness metadata.
- Storage errors or serialization failures do not break conversation loading or overwrite a usable snapshot.

#### Automated Verification
Run `pnpm exec vitest run src/cache/androidConversationCache.test.ts`. The tests use memory-only storage and do not touch server data. Measure performance separately from CI assertions; compare the old repeated-array serialization with `boundAndroidConversationMessages` on 200 messages of 64,000 ASCII characters each.

#### Rollback/Cleanup
Delete the disposable test conversations and clear their test-origin cache using the Android cache control. Restore any isolated network simulation. No real server restart, configuration changes, or production cache deletion is required.
