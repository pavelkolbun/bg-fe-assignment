/**
 * Seeded PRNG (mulberry32). Every random decision in the server flows through
 * an instance of this class.
 *
 * Streams are isolated via fork(): a fork derives its seed from the parent's
 * ORIGINAL seed plus a label, without consuming the parent's state. The
 * simulation owns one stream; each connection forks its own — so client
 * activity can never advance the simulation's RNG and break reproducibility.
 */
export class Rng {
    private state: number;

    constructor(public readonly seed: number) {
        this.state = seed >>> 0;
    }

    /** Uniform float in [0, 1). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    uniform(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    /** Integer in [min, max], inclusive. */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(0, items.length - 1)];
    }

    /** Derive an independent child stream; does not consume this stream's state. */
    fork(label: string): Rng {
        let h = (2166136261 ^ this.seed) >>> 0; // FNV-1a over the label, mixed with the seed
        for (let i = 0; i < label.length; i++) {
            h ^= label.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return new Rng(h >>> 0);
    }
}

export const RNG = Symbol('RNG');
