# Official history pages and shared list reads

## Prerequisites

- An isolated development instance from this branch, an official server supporting `thread/turns/list`, and a disposable conversation with more than 10 turns, including an empty turn and a turn with several assistant/file-change items.
- A legacy RPC fixture returning method-not-found for `thread/turns/list`; never downgrade or restart a production Codex service for this check.
- A temporary SQLite threads fixture, including its WAL, for list-cache checks. Do not mutate real session databases.

## Actions and expected results

1. Open the long conversation and request `/codex-api/rpc` with `thread/read`, `includeTurns:true`. Observe backend RPC calls: metadata-only `thread/read`, then `thread/turns/list` with descending order and full items. The result contains recent turns in chronological order, `hasMoreOlder`, and no invented absolute turn offsets.
2. Scroll to older messages twice. The backend reuses opaque cursors and fetches only the next page. Commands, images, message IDs and final responses remain intact. No extra full-rollout RPC is made. A browser restored from an Android snapshot can locate its first turn through bounded pages if no server-side cursor has been retained.
3. Copy an assistant response containing several messages, expand its file changes, inspect an earlier user's Edit action and Fork a completed reply in the disposable conversation. Grouping uses stable turn IDs, regardless of whether absolute indexes were included in a legacy response.
4. Edit a disposable old turn. The bridge resolves the current rollback count through metadata-only turn pages, including turns with no visible items, while holding its mutation lock. Only official `threadId`/`numTurns` are forwarded. A missing target is an error, not a request to roll back all history.
5. Roll back the disposable conversation from another client and refresh the web conversation. Deleted tail turns disappear; loaded older turns before the overlapping page remain. Repeat after refreshing the browser.
6. With the legacy fixture, a missing pagination method falls back to the former read-and-slice path. A 503/timeout or malformed supported response surfaces as an error and does not trigger an expensive full-history fallback. Reconnection permits capability detection again.
7. Issue identical thread-list requests concurrently: one upstream list RPC is shared; different cursor/filter parameters remain separate. Completed results are not reused as a stale list cache, and a thread mutation separates pre- and post-mutation reads.
8. The first unarchived list page supplements missing imported/forked threads. Later cursor pages do not append the same supplement again. Concurrent supplement loads share DB/WAL metadata checks and one query; a DB/WAL modification or replacement invalidates the result. Completed entries expire after at most one second even if unchanged, with at most eight database paths cached.

## Automated evidence

Run `pnpm exec vitest run src/server/threadHistoryPager.test.ts src/server/threadListSupplementCache.test.ts src/server/codexAppServerBridge.listPerformance.test.ts src/server/codexAppServerBridge.sharedObserver.test.ts src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts src/task/conversationTurnIdentity.test.ts --maxWorkers=2`.

The isolated HTTP tests check chronological pages and assert that no `includeTurns:true` RPC reaches a pagination-capable backend. Ten simultaneous identical list calls execute one upstream call; 20 simultaneous supplement calls execute one loader. These are operation-count checks, not device latency claims.

The new pager was also exercised read-only against the local official server: two pages of two turns used exactly two `thread/turns/list` calls, returned four unique turn IDs with `itemsView=full`, and made no full-history request. Windows/Android UI operations above still require manual device acceptance; unit checks do not claim those actions were performed on production threads.

## Cleanup

Remove only temporary fixtures. Archive any disposable test conversation through the normal UI. No production service, credentials, or official configuration needs to change.
