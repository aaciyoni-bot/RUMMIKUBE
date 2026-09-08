# RUMMIKUBE code review — first repair set

Scope: aaciyoni-bot/RUMMIKUBE, based on main commit 8cad608. CNAME identifies www.rummikube.com. The active deployment/commit has not been verified: Vercel returned no teams and permission to open the production domain in the browser was declined. This is a source review and local regression verification, not a completed live audit of every game or service. POKERTEN is a separate next project.

## Verified and repaired

- Drag cancellation: pointercancel and window blur clear the gesture and pending animation. Releasing outside a destination preserves the original rack positions.
- Tile conservation: returning a tile/group to a full rack is rejected atomically instead of removing tiles from the board without adding them to the rack.
- Duplicate/stale input: a completed drag is cleared synchronously; a gesture from an earlier turn is discarded. Secondary pointers and non-left buttons cannot start a drag.
- Pointer processing: coalesce motion into one animation frame and move the ghost with a composited transform. In the deterministic test, 120 pointer events cause one hit test instead of 120. This is not a production FPS measurement.
- Board sizing: attach ResizeObserver when the loading screen is replaced by the actual board.
- React component identity: move the tile-face component out of RummyTable so timer/hover updates do not remount every tile face.
- Bot computation: move the exact whole-board solver to a disposable worker; terminate at 1.5 seconds and retain the existing heuristic fallback. Cancel when leaving/changing turns and check the latest server turn before using results. The solver algorithm itself is unchanged. Browsers/CSP policies that disallow workers use the heuristic.
- Server-authoritative arrange: keep board sorting local, consistent with other draft-turn actions.
- Server move validation: reject changed tile values/colours, missing tile IDs and missing/duplicate group IDs. This protects the server-authoritative move endpoint; it does not close the legacy Firestore write path.

## Verification

- `node --test tests/*.test.cjs`: 21 tests pass.
- Running the same 10 interaction tests against the original main source: 9 fail, 1 passes; against the repaired source: 10 pass.
- `node functions/rummyEngine.test.js`: existing 9 checks pass.
- Parsed all main HTML inline scripts/JSX, all functions JavaScript modules and scripts in the other HTML pages: 24 blocks/modules; no syntax errors.
- Both embedded solver/brain synchronization checks pass; `git diff --check` passes.
- The interaction tests run the actual inline handlers against deterministic DOM/Firebase/clock adapters. They are not a real browser or multi-client integration test.

## Remaining findings, ordered by impact

| Priority | Evidence in repository | Next work |
| --- | --- | --- |
| High | `firestore.rules`: for legacy tables any authenticated user can change almost all table fields except bank; table reads are also broad. | Test membership/actor restrictions with a Firestore emulator, then stage a server-authoritative migration. Simply flipping the flag can break existing games. |
| High | Legacy drag actions write a complete board/rack through independent transactions; sort/undo/arrange also write directly. | Design ordered/revisioned draft writes and verify rapid consecutive actions, lost connections and turn expiry with multiple clients. |
| High | Private hands and public turn state use separate snapshots; initial-turn synchronization has an early-skip optimization. | Reproduce both snapshot arrival orders in server-authoritative mode, including a turn switch while dragging. |
| Medium | Main application is approximately 1.54 MB in one HTML file, with runtime Babel and Tailwind CDN processing. | Introduce an actual build with pinned dependencies and precompiled JSX/CSS; split game bundles after baseline visual tests. |
| Medium | 202 syntactically empty catch blocks in the main HTML; some fire-and-forget updateDoc calls are wrapped in synchronous try/catch. | Add actionable asynchronous error handling to gameplay boundaries first; avoid logging private hands or account data. |
| Medium | `sw.js` launches cache writes without awaiting them/holding the event alive; same-origin offline matching ignores query strings. | Review cache lifecycle/version policy and test offline/update behavior. |
| Medium | Existing deployment workflow deploys Firebase functions/rules on relevant main pushes without a test step. | Add test gates before production deployment after agreeing on practical simulation limits. |

## Release boundary

These changes are proposed on a repair branch. No main merge, production deployment, Firestore rule update, database modification, or live financial/game operation is part of this repair set. Validate desktop/touch drag, long-press groups, crowded boards, bot turns, network failure and multiple players on a preview before release. A merge touching functions can trigger the existing Firebase deployment workflow. Product redesign and feature selection still need the user's preferences, one question at a time.
