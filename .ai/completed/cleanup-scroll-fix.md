# Cleanup tab scroll fix

Status: IN PROGRESS
Started: 2026-11-02

## Steps
- [x] Make the cleanup content a single scrollable body below the fixed header
- [x] Add a component regression test for the scroll container structure
- [x] Run typecheck and the focused webview tests

## Notes
- Root cause: `.cleanup-container` is `overflow: hidden` and only `.package-list`
  scrolls. The `dependency-issues` card is a non-shrinking flex item, so once it
  is expanded the list is clipped and no element scrolls.

**Status:** DONE
