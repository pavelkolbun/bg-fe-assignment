# Take-home assignment: Crash game live board

Thanks for doing this assignment - we know your time is valuable, so we've kept the scope small on purpose. You'll build a real-time dashboard for a crash-style game. We give you a mock WebSocket server that misbehaves on purpose; your app has to stay correct and fast anyway.

This code is the starting point for your technical interview. We'll spend most of that hour inside your repo, so make choices you can explain.

## Ground rules

- **Time budget: 5–7 hours.** You have 7 calendar days, but spending more time won't earn you more points. If you run out, cut scope on purpose and write down what you cut and why in `DECISIONS.md`. A good cut list counts in your favor.
- **AI tools are fine** - we use them every day too. One condition: you must own every line. In the interview we'll open random files, ask why you chose one approach over another, and change requirements on the spot. Code you can't explain will hurt you much more than a missing bonus feature.
- **Stack:** React 19+ and TypeScript in `strict` mode. Everything else is your call - bundler, state management, virtualization library or your own. Your choices are part of what we evaluate. Don't use a ready-made table component (MUI, AntD, etc.) - that would defeat the point of the task. Styling beyond "tidy" is not graded.
- **Commit as you go.** Small, meaningful commits show us how you work. One big "final" commit tells us nothing.

## Getting started

```bash
corepack enable pnpm    # once, if you don't have pnpm yet (Node >= 20 required)
cd server
pnpm install
pnpm start                 # ws://localhost:8080, chaos on by default
pnpm start --chaos off     # clean mode, handy while building
pnpm start --seed 7        # same seed = same run, fully reproducible
```

Run `pnpm start --help` to see all flags. We will test your submission with the **default flags**.

## The game in 30 seconds

Rounds repeat forever. First, betting is open for ~7 seconds and about 5,000 simulated players place bets. Then the round "takes off": a multiplier climbs from 1.00× (20 ticks per second) and players cash out one by one - 200+ updates per second at peak. At a random moment the round **crashes**: everyone still in loses. After a 3-second pause, the next round starts with fresh bets.

## The server misbehaves on purpose

With default flags, the feed has these problems (all intentional):

- **~2% duplicate messages** - an exact copy, same `seq`, arrives shortly after the original.
- **~2% out-of-order messages** - a message is held back and arrives a few positions late. Use `seq` to detect and fix this.
- **The connection drops every 45–60 seconds** (code 1006). You must reconnect (with backoff). On reconnect you get a fresh `snapshot` - throw away any buffered events with `seq` <= the snapshot's `seq`. If the snapshot disagrees with what your app thinks, the snapshot wins.
- **Clock skew** - `serverTime` in every message is shifted from real time by a constant amount. Don't trust your local clock when comparing against server timestamps like `endsAt` - estimate the offset instead.

## Protocol

### Server → client

Every server message looks like `{ seq, serverTime, type, payload }`. `seq` always increases at the source **for feed messages**, but chaos can reorder or duplicate the delivery. The `snapshot` and the direct replies to your commands (`bet_accepted`, `bet_rejected`, `cashout_accepted`, `cashout_rejected`, `error`) are **not** part of the ordered stream - they just carry the `seq` of the latest feed message for reference. So a reply can share a `seq` with a feed message, and that's not a duplicate. Order and dedupe the feed by `seq`; match replies by `clientBetId` / `betId`.

| type               | payload                                                         | notes                                                             |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `snapshot`         | `{ round, bets[], lastRounds[] }`                               | sent on every (re)connect; the full current state                 |
| `betting_open`     | `{ roundId, endsAt }`                                           | betting phase begins; `endsAt` is in **server** time              |
| `bets_placed`      | `{ bets[] }` (1–50)                                             | simulated players betting; the full set streams in over the phase |
| `round_start`      | `{ roundId, startedAt }`                                        | flight begins                                                     |
| `multiplier_tick`  | `{ value }`                                                     | 20 per second during flight                                       |
| `bet_updated`      | `{ betId, status: "cashed_out", cashedAt }`                     | 200+ per second at peak                                           |
| `round_crash`      | `{ roundId, crashMultiplier }`                                  | **one single message - see the note below**                       |
| `bet_accepted`     | `{ clientBetId, bet }`                                          | reply to your `place_bet`; `bet.isYou === true`                   |
| `bet_rejected`     | `{ clientBetId, reason }`                                       | reply to your `place_bet` (happens ~10% of the time)              |
| `cashout_accepted` | `{ betId, multiplier }`                                         | reply to your `cash_out`                                          |
| `cashout_rejected` | `{ betId, reason: "crashed" \| "not_active" \| "wrong_phase" }` | reply to your `cash_out`                                          |

A `Bet` is `{ id, player, amount, status: "active" | "cashed_out", cashedAt, isYou? }`.

> **Read this note carefully.** `round_crash` is a single message. The server never sends per-bet "lost" updates for the thousands of bets still active at that moment. How your client represents "lost" is one of the most important design decisions in this task.

### Client → server

You send plain JSON frames (no `seq`, no envelope). There are exactly two commands:

| type        | payload you send                                             | valid phase    | server reply                                                       |
| ----------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------ |
| `place_bet` | `{ type: "place_bet", clientBetId: string, amount: number }` | `betting` only | `bet_accepted` or `bet_rejected` (~10%), after a 200–800 ms delay  |
| `cash_out`  | `{ type: "cash_out", betId: string }`                        | `flight` only  | `cashout_accepted` or `cashout_rejected`, after a 200–800 ms delay |

Example:

```jsonc
// you send:
{ "type": "place_bet", "clientBetId": "c-7f3a", "amount": 25.0 }

// 200–800 ms later, the server replies:
{ "seq": 18411, "serverTime": 1718100000123, "type": "bet_accepted",
  "payload": { "clientBetId": "c-7f3a", "bet": { "id": "r1284-c7f3a", "player": "you", "amount": 25.0, "status": "active", "cashedAt": null, "isYou": true } } }
```

A few things to know:

- `clientBetId` is an id **you make up** (any string, unique per round). You need it to match the server's reply with the pending row you showed optimistically - the server's own `bet.id` only arrives in `bet_accepted`.
- The server decides the moment your command **arrives**; the 200–800 ms delay only applies to the reply. An accepted bet also shows up in the feed (a `bets_placed` containing your bet, `isYou: true`), and an accepted cashout produces a normal `bet_updated` in the feed - make sure you don't count your own bet twice.
- Commands sent in the wrong phase get rejected (`reason: "wrong_phase"` / `"round_closed"`), not silently dropped.
- A `cash_out` that arrives at or after the crash is rejected with `reason: "crashed"` - yes, you can lose that race, and your UI must handle it.
- Malformed frames get an `error` message back. The server never closes the connection because of bad input - it closes it on its own schedule instead.

## What to build

A single-page dashboard with four parts. Two reference sketches are included: `prototype-betting.png` (betting phase) and `prototype-flight.png` (round in flight). They show layout and intent, not visual design.

### 1. Live bets table - the centerpiece

All bets for the current round (~5,000 rows): player, amount, cashed-out multiplier, status (`active` / `cashed out` / `lost`).

- The full list is scrollable, but only the visible rows may be mounted (virtualize - use a library or write your own).
- When one bet updates, only that row may re-render - not the whole table, not its neighbors. Prove it with a React Profiler screenshot in `PERFORMANCE.md`.
- Batch incoming updates per animation frame: 200 messages per second must not mean 200 renders per second.
- When a visible row's status or cashout value changes, briefly highlight the changed cell.
- The round transition (5,000 rows out, 5,000 new rows in, every ~30 s) must not visibly stutter.

### 2. Multiplier ticker

A large multiplier readout that animates **smoothly**, even though it only gets 20 ticks per second. Also show the last ~6 round results as colored chips. When the round crashes, make it obvious.

### 3. Connection status bar

Show the current state (`live` / `reconnecting` / `recovering`), the last `seq`, the estimated clock drift (see below), and live counters: duplicates dropped, out-of-order fixed, gaps detected, reconnects. These counters are how we check that your message pipeline really works - with default flags they must be non-zero after a minute. A small debug log of the last ≤50 anomalies (capped - drop old entries) is nice to have; a console log plus the counters is an acceptable minimum.

### 4. Your bet panel

Place a bet during the betting phase: it appears in the table right away as pending, then either becomes confirmed (your `isYou` row) or rolls back cleanly if rejected. During flight, show a **Cash out** button - and handle the race against `round_crash` correctly (the server may reject you).

While betting is open, show a live countdown of the time left (see `prototype-betting.png` - we put it on the button, but anywhere visible is fine). Compute it from `endsAt`, which is in **server** time: estimate the offset between `serverTime` and your local clock and correct for it. That estimated offset is the "drift" value in the status bar.

## Performance gates - pass/fail

Measured with **default server flags**:

1. **60 fps under load:** with the table visible and a round in flight, record 30 seconds in Chrome Performance at **4× CPU throttle** while scrolling the table. No frame may take longer than ~16 ms. Put the trace screenshot in `PERFORMANCE.md`.
2. **Flat memory:** leave the app running for 10 minutes (≈20 rounds). The heap must return to its baseline between rounds - no endless growth. Include a memory timeline screenshot.

## What to hand in

A repository (link) with:

1. The app, with `README` run instructions (`pnpm i && pnpm dev` should be enough).
2. `DECISIONS.md` - your key decisions, the alternatives you rejected and why, what you cut, and what you'd do next with more time. One page is plenty.
3. `PERFORMANCE.md` - what you measured, the two gate screenshots, and a short explanation of _why_ your approach is fast (what re-renders when, and what doesn't).

## How we evaluate

Roughly in this order:

1. **Correctness under chaos** - does the UI end up showing the true state despite duplicates, reordering, and reconnects?
2. **Rendering performance** - the two gates, and the architecture behind them.
3. **State design** - where data lives, what is stored vs. computed, TypeScript quality.
4. **Product judgment** - scope cuts, edge cases like the cashout/crash race.
5. **Communication** - `DECISIONS.md`, commit history.

We don't grade visual design - no points for beauty or themes; assume a designer exists. We do grade UI craft: clear state communication (connection status, pending/confirmed/rejected bets), a layout that stays stable under heavy updates, and interactions that feel responsive. Tidy and readable is the bar; fancy is wasted time.

We review your submission against an unmodified server with a seed of our choosing.

If anything is unclear, make a reasonable assumption and write it down in `DECISIONS.md` - handling ambiguity is part of the job. If the tooling itself is broken (the server won't start, etc.), email us - that's on us.

Good luck - we're looking forward to reading your code.
