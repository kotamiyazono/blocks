# Repository rules

## Tests

- Before adding a test, search the closest existing coverage and extend it when responsibilities match.
- Default to zero new test cases for refactors, fixes, and visual changes.
- Add one focused test only for a distinct behavior or regression not covered elsewhere.
- Rule logic belongs in `test/rules.test.mjs`; end-to-end room flows belong in `test/online-*.test.mjs`. Do not duplicate the same contract across both.
- Test observable behavior, not implementation details; avoid snapshots for local changes.
- Report the test-count delta and summarize results without routine logs.

## UI changes

- Iterate UI changes through actual interaction states (default, selected, dragging, rotated, flipped, disabled), then consolidate repeated patterns into shared CSS instead of keeping one-off styling.
- Prefer existing design tokens and control styles in `styles.css` before introducing new visual rules; verify nearby UI remains consistent after the change.
- The board is never rotated for the opposing seat; each player's pieces sit in their own hand.

Keep this file concise. Add only repository-wide rules that repeatedly prevent concrete problems; merge or remove rules before expanding it.
