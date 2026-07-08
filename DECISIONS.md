# Decisions

## Stack
Vite + React 19 + TypeScript strict, no state library, no table library, plain CSS.
App lives in `client/` (`cd client && pnpm i && pnpm dev`), mirroring `server/`.

## Architecture: a store outside React
`store.ts` is a plain class, not a `useReducer`. The requirement "update one bet →
re-render only that row" is incompatible with one shared state object — any single
`setState` re-renders every consumer regardless of what it actually reads.

Instead each of the ~5,000 bets has its own subscription slot
(`Map<id, Set<listener>>`). `BetRow` calls `useSyncExternalStore(subscribeRow(id), ...)`,
so a `bet_updated` wakes only that row's listeners. Round/connection/your-bet state
are three small separate snapshots, so a 20Hz multiplier tick can't fan out to
components that only care about round phase.

Two real bugs came from the same `useSyncExternalStore` rule — `getSnapshot` must
return a *new reference* exactly when something changed, no more, no less:
- `getConnectionSnapshot` returned a fresh object every call → React saw a "change"
  on every read → infinite render loop.
- The bets `order` array was mutated in place (`push`/`splice`) → reference never
  changed → table stuck at 0 rows despite listeners firing.

Both fixed by making `order`/`connectionSnapshot` swap to a new reference only
inside a single batched `flush()`.

## Batching
Mutations write to the store synchronously (`getSnapshot` always accurate), but
listener notification is deferred to one `requestAnimationFrame` per store. At
200+ `bet_updated`/s this caps React commits at 60/s, touching only dirtied rows.

## Sequencing: dedupe by seq, don't buffer for reordering
`FeedClient` tracks an `expectedSeq` watermark + a 512-entry seen-seq window:
duplicate → drop+count; `seq > expected` → gap, count, move on; `seq < expected`
and unseen → late/reordered, apply it, count it. No holding buffer — every message
type here is either additive-by-id or an idempotent absolute write, so strict
transmission order isn't needed for correctness, only "not twice, not lost."

Two places order *does* matter, so they get explicit guards: the multiplier
(`lastTickSeq` watermark — a late tick must not make the number jump backward),
and cross-round messages (bet ids encode `r{roundId}-...`, so a message delayed
past a round boundary is dropped instead of resurrecting a stray row — caught by
watching the row count briefly overshoot 5,000 under chaos).

## Reconnect and resync
Snapshot wins, literally — bets/round/ticker are replaced, not merged, and the
dedupe window resets to the snapshot's seq. A bet still `pending`/`cashing_out`
across a reconnect resets to `idle` if the snapshot doesn't confirm it — guessing
wrong is worse than asking the user to check.

Connection status: `connecting` → `live` → (drop) `reconnecting` → (socket back)
`recovering` → `live`. Backoff exponential, 300ms→5s, resets on success.

Clock drift = median of last 40 `serverTime - Date.now()` samples; every countdown
is corrected by it instead of trusting the local clock.

## Multiplier ticker: no React state at 60fps
Server emits 20 ticks/s; smoothness comes from linear extrapolation off the rate
between the last two ticks, re-anchored per tick, capped at 150ms. Written straight
to a DOM node via ref inside a `requestAnimationFrame` loop — never `setState`,
since nothing else needs the value every frame.

## "Lost" is derived, never stored
`round_crash` is one message for thousands of still-active bets. Rather than
writing `status: 'lost'` onto every one (O(n) mutation), display status is computed
at render time from `(bet.status, round.phase)`. The store only ever writes
`active`/`cashed_out` — a crash is O(mounted rows), not O(5,000).

## Virtualization & bet panel
Hand-rolled virtualization (~50 lines, fixed row height, overscan) — a library
buys nothing for this constrained a case. Placing a bet inserts a real
`pending:{clientBetId}` row into the same bets map the feed populates, so
"appears immediately as pending" needs no special-case rendering; `bet_accepted`/
`bet_rejected` resolve it, idempotently, regardless of feed-vs-reply ordering.

## What I cut
- Broad automated test coverage — verified instead by driving the real server
  with Playwright (counters non-zero, row count never exceeds 5,000, full bet
  lifecycle, a real reconnect). Since writing this, added a first unit test
  suite for `FeedClient` (dedupe/gap/reorder/drift/reconnect) as the highest-value
  follow-up.
- Sorting/filtering/column resizing — not asked for, and more surface to keep
  correct under a 5,000-row swap every ~30s.
- Cross-reload persistence — a refresh just reconnects and gets a fresh snapshot.
- Anomaly log is a flat capped list, not correlated (gap ↔ its eventual fix).

## Assumptions
- "Last ~6 rounds" (README) vs. server's 10 — UI slices to 6 for the chips.
- `roundId` guards are enough for reorder-safety on round transitions; no full
  seq-based reassembly, since per-type idempotency already covers it.

## With more time
- Expand unit tests to the `Store` itself against synthetic chaos sequences.
- Spring/easing curve for the ticker's crash-stop motion.
- Anomaly log as a real timeline (gap → matching fix), not a flat feed.