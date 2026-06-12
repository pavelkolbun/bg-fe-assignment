import {
    Inject,
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnApplicationShutdown,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { AppConfig, CLOCK, Clock, CONFIG } from '../config/config';
import { Phase, RoundState } from '../protocol/protocol';
import { RNG, Rng } from '../rng/rng.provider';

export const TICK_MS = 50;
export const TICKS_PER_S = 1000 / TICK_MS;
export const CRASHED_TICKS = 20; // 1 s
export const PAUSE_TICKS = 40; // 2 s
const GROWTH = 0.06;
const MAX_BATCH = 50;
const LAST_ROUNDS = 10;

const NAMES = [
    'nova',
    'viper',
    'lucky',
    'maverick',
    'pixel',
    'shadow',
    'comet',
    'drift',
    'echo',
    'falcon',
    'gizmo',
    'haze',
    'indigo',
    'jolt',
    'karma',
    'lunar',
    'mirage',
    'nitro',
    'orbit',
    'pulse',
    'quartz',
    'raven',
    'sonic',
    'tango',
] as const;

/**
 * Server-side bet record. `target` (auto-cashout multiplier, simulated bets only)
 * and `ownerConnId` (client bets only) never cross the wire — the gateway strips
 * them when serializing, attaching `isYou` for the owning connection instead.
 */
export interface BetRecord {
    id: string;
    player: string;
    amount: number;
    status: 'active' | 'cashed_out';
    cashedAt: number | null;
    target: number | null;
    ownerConnId: number | null;
}

/**
 * A produced broadcast message. `seq` is assigned here, when the message is
 * produced — before any per-connection chaos. `ownerConnId` tags feed messages
 * that announce a client-placed bet so the gateway can attach `isYou`.
 */
export type FeedMessage = { seq: number; serverTime: number; ownerConnId?: number } & (
    | { type: 'betting_open'; payload: { roundId: number; endsAt: number } }
    | { type: 'round_start'; payload: { roundId: number; startedAt: number } }
    | { type: 'multiplier_tick'; payload: { value: number } }
    | { type: 'round_crash'; payload: { roundId: number; crashMultiplier: number } }
    | { type: 'bets_placed'; payload: { bets: BetRecord[] } }
    | { type: 'bet_updated'; payload: { betId: string; status: 'cashed_out'; cashedAt: number } }
);

export interface SnapshotData {
    seq: number;
    round: RoundState;
    bets: BetRecord[];
    lastRounds: number[];
}

export function round2(x: number): number {
    return Math.round(x * 100) / 100;
}

/**
 * The endless game loop. Everything runs off ONE 50 ms heartbeat (`step()`),
 * and the multiplier derives from the tick counter, not wall time — that is
 * what makes two runs with the same seed produce the same message sequence.
 */
@Injectable()
export class SimulationService implements OnApplicationBootstrap, OnApplicationShutdown {
    readonly feed$ = new Subject<FeedMessage>();

    private readonly logger = new Logger('Simulation');
    private readonly rng: Rng;
    private readonly bettingTicks: number;

    private seqCounter = 0;
    private currentRoundId = 0;
    private currentPhase: Phase = 'pause';
    private phaseTick = 0;

    private bets: BetRecord[] = [];
    private betsById = new Map<string, BetRecord>();
    private pendingSimBets: BetRecord[] = [];
    private pendingIdx = 0;
    private betSchedule: number[] = [];
    private targetQueue: (BetRecord & { target: number })[] = [];
    private targetIdx = 0;

    private crashPoint = 1;
    private lastTickValue = 1;
    private lastCrash = 1;
    private lastRounds: number[] = [];
    private bettingEndsAt = 0;
    private gapStartedAt = 0;
    private timer?: NodeJS.Timeout;

    constructor(
        @Inject(CONFIG) private readonly config: AppConfig,
        @Inject(RNG) masterRng: Rng,
        @Inject(CLOCK) private readonly clock: Clock,
    ) {
        this.rng = masterRng.fork('sim');
        this.bettingTicks = config.bettingS * TICKS_PER_S;
    }

    onApplicationBootstrap(): void {
        this.begin();
        this.timer = setInterval(() => this.step(), TICK_MS);
    }

    onApplicationShutdown(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = undefined;
        this.feed$.complete();
    }

    get seq(): number {
        return this.seqCounter;
    }

    get phase(): Phase {
        return this.currentPhase;
    }

    get roundId(): number {
        return this.currentRoundId;
    }

    /** Start the first round. Called by the lifecycle hook; tests call it directly. */
    begin(): void {
        this.enterBetting();
    }

    /** One heartbeat. Fixed processing order keeps message production deterministic. */
    step(): void {
        switch (this.currentPhase) {
            case 'betting':
                this.bettingStep();
                break;
            case 'flight':
                this.flightStep();
                break;
            case 'crashed':
                if (++this.phaseTick >= CRASHED_TICKS) {
                    this.currentPhase = 'pause';
                    this.phaseTick = 0;
                }
                break;
            case 'pause':
                if (++this.phaseTick >= PAUSE_TICKS) {
                    this.enterBetting();
                }
                break;
        }
    }

    getSnapshot(): SnapshotData {
        return {
            seq: this.seqCounter,
            round: {
                roundId: this.currentRoundId,
                phase: this.currentPhase,
                multiplier: this.currentMultiplier(),
                phaseEndsAt: this.phaseEndsAt(),
            },
            bets: this.bets,
            lastRounds: [...this.lastRounds],
        };
    }

    hasBet(id: string): boolean {
        return this.betsById.has(id);
    }

    getBet(id: string): BetRecord | undefined {
        return this.betsById.get(id);
    }

    /** Multiplier as the connected clients currently know it (last emitted tick). */
    currentMultiplier(): number {
        if (this.currentPhase === 'flight') {
            return this.lastTickValue;
        }
        if (this.currentPhase === 'betting') {
            return 1;
        }
        return this.lastCrash;
    }

    /** Register an accepted client bet. State mutates at receipt; emission comes later. */
    addClientBet(connId: number, clientBetId: string, amount: number): BetRecord {
        const record: BetRecord = {
            id: `r${this.currentRoundId}-${clientBetId}`,
            player: 'you',
            amount: round2(amount),
            status: 'active',
            cashedAt: null,
            target: null,
            ownerConnId: connId,
        };
        this.bets.push(record);
        this.betsById.set(record.id, record);
        return record;
    }

    /** Announce an accepted client bet on the feed (called when the delayed reply fires). */
    emitClientBet(record: BetRecord): void {
        this.produce(
            { type: 'bets_placed', payload: { bets: [record] } },
            record.ownerConnId ?? undefined,
        );
    }

    /** Cash a client bet out at the current multiplier. State mutates at receipt. */
    cashOutNow(record: BetRecord): number {
        const value = this.currentMultiplier();
        record.status = 'cashed_out';
        record.cashedAt = value;
        return value;
    }

    /** Announce a client cashout on the feed (called when the delayed reply fires). */
    emitCashout(record: BetRecord): void {
        this.produce({
            type: 'bet_updated',
            payload: { betId: record.id, status: 'cashed_out', cashedAt: record.cashedAt ?? 1 },
        });
    }

    private produce(
        msg: { type: FeedMessage['type']; payload: FeedMessage['payload'] },
        ownerConnId?: number,
    ): void {
        this.seqCounter++;
        const full = { seq: this.seqCounter, serverTime: this.clock(), ...msg } as FeedMessage;
        if (ownerConnId !== undefined) {
            full.ownerConnId = ownerConnId;
        }
        this.feed$.next(full);
    }

    private enterBetting(): void {
        this.currentRoundId++;
        this.currentPhase = 'betting';
        this.phaseTick = 0;
        this.bets = [];
        this.betsById.clear();
        // minX scales the whole distribution (median ~2x the floor), keeping the
        // long-tail shape; with the defaults (1/100) this is the spec formula.
        const { minX, maxX } = this.config;
        this.crashPoint = Math.max(minX, Math.min(maxX, (minX * 0.97) / this.rng.next()));
        this.lastTickValue = 1;
        this.pendingSimBets = this.generateSimBets();
        this.pendingIdx = 0;
        this.betSchedule = this.buildSchedule(this.pendingSimBets.length);
        this.bettingEndsAt = this.clock() + this.bettingTicks * TICK_MS;
        this.produce({
            type: 'betting_open',
            payload: { roundId: this.currentRoundId, endsAt: this.bettingEndsAt },
        });
    }

    private bettingStep(): void {
        const count = this.betSchedule[this.phaseTick] ?? 0;
        if (count > 0) {
            const batch = this.pendingSimBets.slice(this.pendingIdx, this.pendingIdx + count);
            this.pendingIdx += count;
            for (const record of batch) {
                this.bets.push(record);
                this.betsById.set(record.id, record);
            }
            for (let i = 0; i < batch.length; i += MAX_BATCH) {
                this.produce({
                    type: 'bets_placed',
                    payload: { bets: batch.slice(i, i + MAX_BATCH) },
                });
            }
        }
        if (++this.phaseTick >= this.bettingTicks) {
            this.enterFlight();
        }
    }

    private enterFlight(): void {
        this.currentPhase = 'flight';
        this.phaseTick = 0;
        this.pendingSimBets = [];
        this.targetQueue = this.bets
            .filter((b): b is BetRecord & { target: number } => b.target !== null)
            .sort((a, b) => a.target - b.target);
        this.targetIdx = 0;
        this.produce({
            type: 'round_start',
            payload: { roundId: this.currentRoundId, startedAt: this.clock() },
        });
    }

    private flightStep(): void {
        const raw = Math.exp((GROWTH * this.phaseTick) / 20);
        if (raw >= this.crashPoint - 1e-9) {
            this.crash();
            return;
        }
        const value = round2(raw);
        this.lastTickValue = value;
        this.produce({ type: 'multiplier_tick', payload: { value } });
        while (
            this.targetIdx < this.targetQueue.length &&
            this.targetQueue[this.targetIdx].target <= raw
        ) {
            const record = this.targetQueue[this.targetIdx++];
            record.status = 'cashed_out';
            record.cashedAt = value;
            this.produce({
                type: 'bet_updated',
                payload: { betId: record.id, status: 'cashed_out', cashedAt: value },
            });
        }
        this.phaseTick++;
    }

    private crash(): void {
        const crashMultiplier = round2(this.crashPoint);
        this.produce({
            type: 'round_crash',
            payload: { roundId: this.currentRoundId, crashMultiplier },
        });
        this.lastCrash = crashMultiplier;
        this.lastRounds.unshift(crashMultiplier);
        if (this.lastRounds.length > LAST_ROUNDS) {
            this.lastRounds.length = LAST_ROUNDS;
        }
        const cashed = this.bets.reduce((n, b) => n + (b.status === 'cashed_out' ? 1 : 0), 0);
        this.logger.log(
            `round ${this.currentRoundId} crashed at ${crashMultiplier}x, ${cashed}/${this.bets.length} cashed out`,
        );
        this.currentPhase = 'crashed';
        this.phaseTick = 0;
        this.gapStartedAt = this.clock();
        this.targetQueue = [];
    }

    private phaseEndsAt(): number | null {
        switch (this.currentPhase) {
            case 'betting':
                return this.bettingEndsAt;
            case 'flight':
                return null; // the crash is unpredictable
            case 'crashed':
                return this.gapStartedAt + CRASHED_TICKS * TICK_MS;
            case 'pause':
                return this.gapStartedAt + (CRASHED_TICKS + PAUSE_TICKS) * TICK_MS;
        }
    }

    private generateSimBets(): BetRecord[] {
        const records: BetRecord[] = [];
        for (let i = 0; i < this.config.players; i++) {
            records.push({
                id: `r${this.currentRoundId}-p${String(i).padStart(4, '0')}`,
                player: `${this.rng.pick(NAMES)}_${this.rng.int(1, 9999)}`,
                amount: this.drawAmount(),
                status: 'active',
                cashedAt: null,
                target: this.drawTarget(),
                ownerConnId: null,
            });
        }
        return records;
    }

    /** Log-normal-ish: bell-shaped in log space, 1.00–500.00. */
    private drawAmount(): number {
        const z = (this.rng.next() + this.rng.next() + this.rng.next()) / 3;
        return round2(Math.min(500, Math.max(1, Math.exp(z * Math.log(500)))));
    }

    /** Clustered 1.3×–3.0×; ~20% of players ride past 5×. */
    private drawTarget(): number {
        if (this.rng.next() < 0.2) {
            return Math.min(100, 5 + -Math.log(1 - this.rng.next()) * 6);
        }
        return 1.3 + (this.rng.next() + this.rng.next()) * 0.85;
    }

    /**
     * Distribute `total` bets over the betting ticks, front-loaded with an
     * exponential taper (peak ≈ 1,200 bets/s, ~350/s by phase end). Cumulative
     * rounding guarantees the counts sum to exactly `total`.
     */
    private buildSchedule(total: number): number[] {
        const ticks = this.bettingTicks;
        const weights = Array.from({ length: ticks }, (_, i) => Math.exp((-1.2 * i) / ticks));
        const sum = weights.reduce((a, b) => a + b, 0);
        let acc = 0;
        let assigned = 0;
        return weights.map((w) => {
            acc += w;
            const upto = Math.round((total * acc) / sum);
            const n = upto - assigned;
            assigned = upto;
            return n;
        });
    }
}
