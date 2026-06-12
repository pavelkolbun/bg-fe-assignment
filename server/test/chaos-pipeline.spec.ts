import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChaosPipeline } from '../src/chaos/chaos-pipeline';
import { Rng } from '../src/rng/rng.provider';

const BASE = { chaos: true, dupes: 0.05, shuffle: 0.05, dropMinS: 9_000, dropMaxS: 10_000 };

function run(count: number, config = BASE, seed = 42): { pushed: string[]; delivered: string[] } {
    const delivered: string[] = [];
    const pipeline = new ChaosPipeline(config, new Rng(seed), {
        deliver: (f) => delivered.push(f),
        forceDrop: () => undefined,
    });
    const pushed: string[] = [];
    for (let i = 0; i < count; i++) {
        const frame = JSON.stringify({ seq: i + 1 });
        pushed.push(frame);
        pipeline.push(frame);
    }
    pipeline.destroy();
    return { pushed, delivered };
}

describe('ChaosPipeline', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('delivers every frame exactly once, plus byte-identical duplicates', () => {
        const { pushed, delivered } = run(2000);
        const counts = new Map<string, number>();
        for (const f of delivered) {
            counts.set(f, (counts.get(f) ?? 0) + 1);
        }
        // anything pushed more than ~8 positions before the end must be out of the queue
        const settled = pushed.slice(0, -10);
        for (const f of settled) {
            const n = counts.get(f) ?? 0;
            expect(n).toBeGreaterThanOrEqual(1); // nothing lost
            expect(n).toBeLessThanOrEqual(2); // at most one duplicate per frame
        }
        const dupCount = [...counts.values()].filter((n) => n === 2).length;
        expect(dupCount).toBeGreaterThan(0); // duplicates do occur at 5% over 2000 frames
        expect(delivered.length).toBeGreaterThan(pushed.length - 10); // duplicates only add
    });

    it('reorders some frames, displacing them by a bounded number of positions', () => {
        const { delivered } = run(2000);
        const seqs = delivered.map((f) => (JSON.parse(f) as { seq: number }).seq);
        const outOfOrder = seqs.filter((s, i) => i > 0 && s < seqs[i - 1]);
        expect(outOfOrder.length).toBeGreaterThan(0);
        // Displacement bound, measured on first deliveries only (duplicates shift
        // absolute indexes): a frame held <= 4 positions stays near its push slot.
        const seen = new Set<number>();
        const firstDeliveries: number[] = [];
        for (const s of seqs) {
            if (!seen.has(s)) {
                seen.add(s);
                firstDeliveries.push(s);
            }
        }
        firstDeliveries.forEach((s, idx) => {
            expect(Math.abs(idx - (s - 1))).toBeLessThanOrEqual(12);
        });
    });

    it('is deterministic for a given seed', () => {
        const a = run(1000, BASE, 7);
        const b = run(1000, BASE, 7);
        const c = run(1000, BASE, 8);
        expect(a.delivered).toEqual(b.delivered);
        expect(c.delivered).not.toEqual(a.delivered);
    });

    it('with chaos off, is a transparent pass-through', () => {
        const { pushed, delivered } = run(500, { ...BASE, chaos: false });
        expect(delivered).toEqual(pushed);
    });

    it('schedules the forced drop inside the configured window; destroy() cancels it', () => {
        const config = { ...BASE, dropMinS: 45, dropMaxS: 60 };
        let dropped = 0;
        const _pipeline = new ChaosPipeline(config, new Rng(42), {
            deliver: () => undefined,
            forceDrop: () => dropped++,
        });
        vi.advanceTimersByTime(45_000 - 1);
        expect(dropped).toBe(0);
        vi.advanceTimersByTime(15_001);
        expect(dropped).toBe(1);

        dropped = 0;
        const second = new ChaosPipeline(config, new Rng(42), {
            deliver: () => undefined,
            forceDrop: () => dropped++,
        });
        second.destroy();
        vi.advanceTimersByTime(120_000);
        expect(dropped).toBe(0);
    });

    it('does not schedule a drop when chaos is off', () => {
        let dropped = 0;
        new ChaosPipeline({ ...BASE, chaos: false }, new Rng(42), {
            deliver: () => undefined,
            forceDrop: () => dropped++,
        });
        vi.advanceTimersByTime(10_000_000);
        expect(dropped).toBe(0);
    });
});
