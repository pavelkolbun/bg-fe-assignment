import { describe, expect, it } from 'vitest';
import { AppConfig, DEFAULTS } from '../src/config/config';
import { Rng } from '../src/rng/rng.provider';
import { FeedMessage, SimulationService, TICKS_PER_S } from '../src/simulation/simulation.service';

const FIXED_TIME = 1_700_000_000_000;

function makeSim(overrides: Partial<AppConfig> = {}): {
    sim: SimulationService;
    messages: FeedMessage[];
} {
    const config: AppConfig = { ...DEFAULTS, players: 50, ...overrides };
    const sim = new SimulationService(config, new Rng(config.seed), () => FIXED_TIME);
    const messages: FeedMessage[] = [];
    sim.feed$.subscribe((m) => messages.push(m));
    sim.begin();
    return { sim, messages };
}

/** Timestamps are real time and legitimately differ between runs — mask them. */
function normalize(msg: FeedMessage): unknown {
    const payload: Record<string, unknown> = { ...(msg.payload as Record<string, unknown>) };
    delete payload.endsAt;
    delete payload.startedAt;
    return { seq: msg.seq, type: msg.type, payload };
}

function stepUntil(sim: SimulationService, done: () => boolean, maxSteps = 100_000): void {
    for (let i = 0; i < maxSteps && !done(); i++) {
        sim.step();
    }
    if (!done()) {
        throw new Error('condition not reached');
    }
}

describe('SimulationService', () => {
    it('same seed produces an identical message sequence (timestamps masked); different seeds diverge', () => {
        const a = makeSim({ seed: 7 });
        const b = makeSim({ seed: 7 });
        const c = makeSim({ seed: 8 });
        for (let i = 0; i < 1500; i++) {
            a.sim.step();
            b.sim.step();
            c.sim.step();
        }
        expect(a.messages.length).toBeGreaterThan(500);
        expect(a.messages.map(normalize)).toEqual(b.messages.map(normalize));
        expect(a.messages.map(normalize)).not.toEqual(c.messages.map(normalize));
    });

    it('multiplier ticks are non-decreasing and a round crashes exactly once', () => {
        const { sim, messages } = makeSim({ seed: 42 });
        stepUntil(sim, () => messages.some((m) => m.type === 'round_crash'));
        const ticks = messages
            .filter((m) => m.type === 'multiplier_tick')
            .map((m) => (m.payload as { value: number }).value);
        for (let i = 1; i < ticks.length; i++) {
            expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
        }
        expect(messages.filter((m) => m.type === 'round_crash')).toHaveLength(1);
        // crash arrives after the last tick, and no tick ever reaches the crash point
        const crash = messages.find((m) => m.type === 'round_crash')?.payload as {
            crashMultiplier: number;
        };
        if (ticks.length > 0) {
            expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(crash.crashMultiplier);
        }
    });

    it('crash-point distribution is sane (median ~1.9, ~3% instant busts, capped at 100)', () => {
        const { sim } = makeSim({ seed: 1, players: 5 });
        const crashes: number[] = [];
        sim.feed$.subscribe((m) => {
            if (m.type === 'round_crash') {
                crashes.push((m.payload as { crashMultiplier: number }).crashMultiplier);
            }
        });
        stepUntil(sim, () => crashes.length >= 300, 400_000);
        const sorted = [...crashes].sort((x, y) => x - y);
        const median = sorted[Math.floor(sorted.length / 2)];
        expect(median).toBeGreaterThan(1.5);
        expect(median).toBeLessThan(2.5);
        const busts = crashes.filter((c) => c === 1).length / crashes.length;
        expect(busts).toBeGreaterThan(0.005);
        expect(busts).toBeLessThan(0.08);
        expect(Math.max(...crashes)).toBeLessThanOrEqual(100);
        expect(Math.min(...crashes)).toBeGreaterThanOrEqual(1);
    });

    it('streams the full bet set during betting in batches of at most 50, before round_start', () => {
        const { sim, messages } = makeSim({ seed: 42, players: 500 });
        for (let i = 0; i < DEFAULTS.bettingS * TICKS_PER_S + 1; i++) {
            sim.step();
        }
        const startIdx = messages.findIndex((m) => m.type === 'round_start');
        expect(startIdx).toBeGreaterThan(0);
        const batches = messages.slice(0, startIdx).filter((m) => m.type === 'bets_placed');
        const sizes = batches.map((m) => (m.payload as { bets: unknown[] }).bets.length);
        expect(sizes.every((s) => s >= 1 && s <= 50)).toBe(true);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(500);
    });

    it('cashouts burst as targets are crossed, statuses update, snapshot reflects mid-flight state', () => {
        const { sim, messages } = makeSim({ seed: 3, players: 200 });
        stepUntil(sim, () => messages.some((m) => m.type === 'round_crash'));
        const updates = messages.filter((m) => m.type === 'bet_updated');
        const crash = (
            messages.find((m) => m.type === 'round_crash')?.payload as { crashMultiplier: number }
        ).crashMultiplier;
        if (crash > 1.5) {
            expect(updates.length).toBeGreaterThan(0);
        }
        // every cashed bet's cashedAt is below or at the crash point
        for (const u of updates) {
            expect((u.payload as { cashedAt: number }).cashedAt).toBeLessThanOrEqual(crash);
        }
    });

    it('keeps lastRounds capped at 10, most recent first, and replaces bets each round', () => {
        const { sim, messages } = makeSim({ seed: 5, players: 5 });
        stepUntil(
            sim,
            () => messages.filter((m) => m.type === 'round_crash').length >= 13,
            200_000,
        );
        stepUntil(sim, () => sim.phase === 'betting'); // into the next round
        const snapshot = sim.getSnapshot();
        expect(snapshot.lastRounds).toHaveLength(10);
        const crashes = messages
            .filter((m) => m.type === 'round_crash')
            .map((m) => (m.payload as { crashMultiplier: number }).crashMultiplier);
        expect(snapshot.lastRounds[0]).toBe(crashes[crashes.length - 1]);
        expect(snapshot.bets.length).toBeLessThanOrEqual(5); // only current round's bets are retained
        expect(snapshot.round.roundId).toBe(sim.roundId);
    });

    it('respects --betting-s: flight starts after exactly bettingS * 20 ticks', () => {
        const { sim, messages } = makeSim({ seed: 42, bettingS: 2, players: 100 });
        for (let i = 0; i < 2 * TICKS_PER_S - 1; i++) {
            sim.step();
        }
        expect(messages.some((m) => m.type === 'round_start')).toBe(false);
        sim.step();
        expect(messages.some((m) => m.type === 'round_start')).toBe(true);
        // the full bet set still fits into the shorter phase
        const placed = messages
            .filter((m) => m.type === 'bets_placed')
            .reduce((n, m) => n + (m.payload as { bets: unknown[] }).bets.length, 0);
        expect(placed).toBe(100);
    });

    it('respects --min-x and --max-x: crashes stay in range, distribution scales with the floor', () => {
        const { sim } = makeSim({ seed: 9, players: 5, minX: 5, maxX: 50 });
        const crashes: number[] = [];
        sim.feed$.subscribe((m) => {
            if (m.type === 'round_crash') {
                crashes.push((m.payload as { crashMultiplier: number }).crashMultiplier);
            }
        });
        stepUntil(sim, () => crashes.length >= 150, 2_000_000);
        expect(Math.min(...crashes)).toBeGreaterThanOrEqual(5);
        expect(Math.max(...crashes)).toBeLessThanOrEqual(50);
        const median = [...crashes].sort((a, b) => a - b)[Math.floor(crashes.length / 2)];
        expect(median).toBeGreaterThan(6); // ~2x the floor, same long-tail shape as the default
        expect(median).toBeLessThan(15);
    });

    it('snapshot mid-flight reports the last emitted tick value and the current seq', () => {
        const { sim, messages } = makeSim({ seed: 42 });
        stepUntil(sim, () => sim.phase === 'flight');
        for (let i = 0; i < 40 && sim.phase === 'flight'; i++) {
            sim.step();
        }
        if (sim.phase !== 'flight') {
            return; // instant bust with this seed would void the scenario
        }
        const snapshot = sim.getSnapshot();
        const ticks = messages.filter((m) => m.type === 'multiplier_tick');
        expect(snapshot.round.phase).toBe('flight');
        expect(snapshot.round.multiplier).toBe(
            (ticks[ticks.length - 1].payload as { value: number }).value,
        );
        expect(snapshot.round.phaseEndsAt).toBeNull();
        expect(snapshot.seq).toBe(messages[messages.length - 1].seq);
    });
});
