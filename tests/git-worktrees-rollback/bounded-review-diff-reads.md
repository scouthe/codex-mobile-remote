### Bounded Git review reads

#### Prerequisites / Setup

- Use a disposable Git repository with an initial commit, a modified tracked file, and at least 24 untracked text files.
- Use the current development server. Do not restart the official Codex service.

#### Actions

1. Open the changed-files panel from several clients at the same time, pointing to the same repository and unstaged view.
2. Verify all 24 untracked files and their complete patches appear in the same order.
3. Repeat with two repositories simultaneously; inspect child processes or run `pnpm exec vitest run src/server/reviewGit.test.ts` for instrumented process counts.
4. Switch between staged, unstaged, base-branch and commit views; select different base branches and commits.
5. Stage the modified tracked file while an unstaged review read is still running, then refresh both views immediately.
6. Edit a file directly in the disposable repository and refresh the review summary.

#### Expected Results

- Identical concurrent requests share a single read; different repositories and view parameters remain separate.
- At most four untracked-file `git diff --no-index` children run at once across all review requests. Every patch is returned; no file cap or truncation is introduced.
- Stage/unstage/revert and repository initialization invalidate in-flight read sharing before and after the mutation. A later request cannot join an older read.
- Completed responses are not cached. Direct filesystem/Git edits appear on the next request without waiting for a TTL.
- The regression fixture issues ten simultaneous snapshots across two repositories with twelve untracked files each: it expects 24 diff children rather than 120, with peak concurrency no greater than four.

#### Rollback / Cleanup

- Remove only the disposable test repository. Automated fixtures clean up their own temporary directories.
