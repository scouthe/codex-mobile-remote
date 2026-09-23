# Assistant response Fork action icon

## Prerequisites

- Run the web UI and open a thread with a completed assistant response that has a turn ID.
- Test both light and dark themes on a desktop browser and a touch-sized viewport.

## Steps

1. Hover over an assistant response, then hover or keyboard-focus its diagonal-arrow Fork button.
2. Verify a dark `分支到新聊天` tooltip appears above the round button; the button remains discoverable with keyboard focus.
3. On a touch-sized viewport, check the Fork button is visible without hover and has an accessible label. No hover tooltip should cover the conversation.
4. Click once and wait for the new thread; do not click repeatedly while the server processes the fork.
5. Without sending a message, confirm the Fork appears in the left conversation list. Refresh the page and confirm it remains there. Open the same project in a second browser and confirm it appears once there too.
6. Send one message in the Fork and confirm the same list entry remains, without a duplicate.

## Expected results

- The Fork action uses the two diagonal arrows from the desktop client, without a separate `Fork` text label.
- Light and dark themes have a legible button and tooltip; Copy and Edit actions are unchanged.
- The button still emits the selected turn ID for forking.
- An unsent Fork is listed immediately and survives a refresh; after its first message, the official list entry replaces the fallback without duplication.

## Cleanup

- Archive the test Fork after verifying its content; it must disappear from the left conversation list.
