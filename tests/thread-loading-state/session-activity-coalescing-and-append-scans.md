### Session activity coalescing and append scans

#### Feature/Change Name
Share concurrent session-activity stat/read work for the same path, bound cached results, and incrementally scan only complete appended JSONL records.

#### Prerequisites/Setup
1. Use disposable JSONL files in a temporary directory and an isolated development process. Do not modify real session files, restart the persistent service, or change Codex settings.
2. Reuse one `ThreadSessionActivityReader` for all reads in a scenario. Observe filesystem `stat`, range-open and full-file read counts.
3. Use newline-terminated `event_msg` records with `task_started`, `task_complete`, or `task_failed` payloads. Also prepare a file larger than 4 MiB containing only non-marker `response_item` records.

#### Steps
1. Request the same active file 25 times concurrently. Repeat the concurrent batch without modifying it.
2. Append a terminal marker and immediately read again without any delay or TTL wait.
3. Read the large marker-free file, append ordinary records three times, and read after each append. Then append its first `task_started` marker.
4. Split a terminal marker into two writes, including a split inside a Chinese UTF-8 character. Read after each write. Also test a syntactically complete JSON object whose terminating newline arrives in a later write.
5. Truncate a cached file, then append new records. Separately replace it with a longer file whose former append boundary differs, and atomically replace it with a different file preserving the old size and mtime.
6. Set a fixture's mtime more than 24 hours old, read it, append fresh ordinary output, and read again.
7. Read 513 different fixture paths through one reader. Revisit the newest and then the oldest.

#### Expected Results
- The initial concurrent batch performs one stat and one scan for the shared path. An unchanged batch still stats once but does not reopen the file.
- The next read after an append immediately observes the new marker; there is no time-based stale-result reuse.
- A marker-free large file is fully scanned once. Subsequent revisions inspect appended bytes and keep unknown state until a definitive marker appears.
- A partial final record remains unconsumed. Its bytes are read again from the last complete newline and parsed after completion, without corrupting split UTF-8 characters.
- Truncation, changed append-boundary bytes, and inode replacement invalidate the incremental state. Activity from the previous contents is not retained.
- Old files remain unknown, rather than asserting an old task is still running. A fresh append allows scanning again.
- At most 512 completed activity results remain cached. A recently accessed entry is reused; an evicted entry is read again.

#### Automated Verification
Run `pnpm exec vitest run src/server/threadSessionActivity.test.ts`. These tests use real temporary files and count the actual filesystem calls; no wall-clock performance assertion is used.

#### Rollback/Cleanup
Remove only the disposable fixture directory after the reader finishes. The automated tests clean up their own `mkdtemp` directories. No real session or server rollback is required.
