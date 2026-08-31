# Android Remote Shell

Android-specific checks for the WebView shell, the optional `window.CodexAndroid`
bridge, and the shared-observer state contract.

Return to the [manual test index](../../tests.md).

## Test Sections

| Section |
| --- |
| [Bridge contract, task notifications, and share intake](bridge-contract-task-notifications-and-share-intake.md) |

## Automated contract tests

The JSON parsing and task-state normalization used by the web-side adapter are
covered by a pure TypeScript test (no Android device or WebView required):

```bash
pnpm exec vitest run src/native/codexAndroid.test.ts
```

These tests intentionally do not read shared files. File bytes are read only
when the caller explicitly invokes the native `readSharedContent(uri)` method,
so a large Android share cannot be pulled into JavaScript accidentally.

