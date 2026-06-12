import { AppConfig } from '../config/config';
import { Rng } from '../rng/rng.provider';

export interface PipelineHooks {
    deliver: (frame: string) => void;
    forceDrop: () => void;
    debug?: (msg: string) => void;
}

interface QueuedFrame {
    frame: string;
    after: number; // remaining positions before delivery
}

type ChaosConfig = Pick<AppConfig, 'chaos' | 'dupes' | 'shuffle' | 'dropMinS' | 'dropMaxS'>;

/**
 * Per-connection delivery chaos. Sits between the simulation stream and the
 * socket; only broadcast feed frames pass through it — snapshots and direct
 * replies bypass it entirely.
 *
 * Frames arrive already serialized (per connection), so a duplicate re-sends
 * the exact same string — byte-identical by construction. A "position" is a
 * subsequent feed frame on this connection: across the 3 s post-crash gap a
 * held frame simply waits, which is intended hostility.
 */
export class ChaosPipeline {
    private queue: QueuedFrame[] = [];
    private dropTimer?: NodeJS.Timeout;

    constructor(
        private readonly config: ChaosConfig,
        private readonly rng: Rng,
        private readonly hooks: PipelineHooks,
    ) {
        if (config.chaos) {
            const ms = Math.round(rng.uniform(config.dropMinS * 1000, config.dropMaxS * 1000));
            this.dropTimer = setTimeout(() => hooks.forceDrop(), ms);
            hooks.debug?.(`forced drop scheduled in ${(ms / 1000).toFixed(1)}s`);
        }
    }

    push(frame: string): void {
        if (!this.config.chaos) {
            this.hooks.deliver(frame);
            return;
        }
        // Entries queued by earlier pushes age by one position per incoming frame;
        // entries queued by THIS push must not age yet, so remember the boundary.
        const preexisting = this.queue.length;

        if (this.rng.next() < this.config.shuffle) {
            const after = this.rng.int(1, 4);
            this.queue.push({ frame, after });
            this.hooks.debug?.(`held a frame back ${after} positions`);
        } else {
            this.hooks.deliver(frame);
            if (this.rng.next() < this.config.dupes) {
                const after = this.rng.int(1, 4);
                this.queue.push({ frame, after });
                this.hooks.debug?.(`duplicate scheduled ${after} positions later`);
            }
        }

        if (preexisting > 0) {
            const due: QueuedFrame[] = [];
            const kept: QueuedFrame[] = [];
            this.queue.forEach((entry, idx) => {
                if (idx < preexisting && --entry.after <= 0) {
                    due.push(entry);
                } else {
                    kept.push(entry);
                }
            });
            this.queue = kept;
            for (const entry of due) {
                this.hooks.deliver(entry.frame);
            }
        }
    }

    destroy(): void {
        if (this.dropTimer) {
            clearTimeout(this.dropTimer);
        }
        this.dropTimer = undefined;
        this.queue = [];
    }
}
