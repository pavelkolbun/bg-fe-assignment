import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AppConfig, DEFAULTS, makeClock } from '../src/config/config';
import { FeedGateway } from '../src/feed/feed.gateway';
import { Bet, ServerMessage } from '../src/protocol/protocol';
import { Rng } from '../src/rng/rng.provider';
import { SimulationService } from '../src/simulation/simulation.service';

class FakeSocket {
    readyState = 1;
    sent: string[] = [];
    private handlers = new Map<string, (data: Buffer) => void>();

    send(frame: string): void {
        this.sent.push(frame);
    }

    on(event: string, handler: (data: Buffer) => void): void {
        this.handlers.set(event, handler);
    }

    terminate(): void {
        this.readyState = 3;
    }

    message(payload: unknown): void {
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.handlers.get('message')?.(Buffer.from(raw));
    }

    frames(): ServerMessage[] {
        return this.sent.map((s) => JSON.parse(s) as ServerMessage);
    }

    framesOf(type: string): ServerMessage[] {
        return this.frames().filter((f) => f.type === type);
    }

    asWs(): WebSocket {
        return this as unknown as WebSocket;
    }
}

interface Harness {
    config: AppConfig;
    sim: SimulationService;
    gateway: FeedGateway;
}

// chaos off: no drop timers and a transparent pipeline; the 200-800ms reply latency still applies
function makeHarness(overrides: Partial<AppConfig> = {}): Harness {
    const config: AppConfig = {
        ...DEFAULTS,
        players: 20,
        chaos: false,
        rejectRate: 0,
        ...overrides,
    };
    const masterRng = new Rng(config.seed);
    const clock = makeClock(config);
    const sim = new SimulationService(config, masterRng, clock);
    sim.begin();
    const gateway = new FeedGateway(config, masterRng, clock, sim);
    return { config, sim, gateway };
}

function stepUntil(sim: SimulationService, done: () => boolean, maxSteps = 100_000): void {
    for (let i = 0; i < maxSteps && !done(); i++) {
        sim.step();
    }
    if (!done()) {
        throw new Error('condition not reached');
    }
}

const FLUSH_REPLIES = 801;

describe('FeedGateway', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends a snapshot immediately on connection, stamped with the current seq', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        const first = sock.frames()[0];
        expect(first.type).toBe('snapshot');
        expect(first.seq).toBe(sim.seq);
        const payload = first.payload as {
            round: { phase: string };
            bets: Bet[];
            lastRounds: number[];
        };
        expect(payload.round.phase).toBe('betting');
        expect(Array.isArray(payload.bets)).toBe(true);
    });

    it('accepts a bet during betting: delayed reply, isYou, feed announcement, snapshot presence', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'c-77', amount: 25 });
        expect(sock.framesOf('bet_accepted')).toHaveLength(0); // not before the latency window
        vi.advanceTimersByTime(FLUSH_REPLIES);
        const accepted = sock.framesOf('bet_accepted');
        expect(accepted).toHaveLength(1);
        const bet = (accepted[0].payload as { clientBetId: string; bet: Bet }).bet;
        expect(bet.id).toBe(`r${sim.roundId}-c-77`);
        expect(bet.player).toBe('you');
        expect(bet.isYou).toBe(true);
        // announced to the feed as a bets_placed at the same moment
        const announced = sock
            .framesOf('bets_placed')
            .some((m) =>
                (m.payload as { bets: Bet[] }).bets.some(
                    (b) => b.id === bet.id && b.isYou === true,
                ),
            );
        expect(announced).toBe(true);
        // a second connection sees the bet, but without isYou
        const sock2 = new FakeSocket();
        gateway.handleConnection(sock2.asWs());
        const snap = sock2.frames()[0].payload as { bets: Bet[] };
        const seen = snap.bets.find((b) => b.id === bet.id);
        expect(seen).toBeDefined();
        expect(seen?.isYou).toBeUndefined();
    });

    it('rejects a duplicate clientBetId within the same round with an error', () => {
        const { gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'dup', amount: 10 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        sock.message({ type: 'place_bet', clientBetId: 'dup', amount: 10 });
        expect(sock.framesOf('error')).toHaveLength(1);
    });

    it('rejects place_bet outside the betting phase — never silently', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        stepUntil(sim, () => sim.phase === 'flight');
        sock.message({ type: 'place_bet', clientBetId: 'late', amount: 10 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        const rejected = sock.framesOf('bet_rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0].payload as { reason: string }).reason).toBe('round_closed');
    });

    it('honours rejectRate with reason limit_exceeded', () => {
        const { gateway } = makeHarness({ rejectRate: 1 });
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'r1', amount: 10 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        expect((sock.framesOf('bet_rejected')[0].payload as { reason: string }).reason).toBe(
            'limit_exceeded',
        );
    });

    it('cashes out an own active bet during flight at the multiplier seen at receipt', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'win', amount: 50 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        stepUntil(sim, () => sim.phase === 'flight');
        for (let i = 0; i < 30 && sim.phase === 'flight'; i++) {
            sim.step();
        }
        if (sim.phase !== 'flight') {
            return; // instant bust would void the scenario for this seed
        }
        const atReceipt = sim.currentMultiplier();
        sock.message({ type: 'cash_out', betId: `r${sim.roundId}-win` });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        const accepted = sock.framesOf('cashout_accepted');
        expect(accepted).toHaveLength(1);
        expect((accepted[0].payload as { multiplier: number }).multiplier).toBe(atReceipt);
        // the cashout also reaches the feed as a regular bet_updated
        const updated = sock
            .framesOf('bet_updated')
            .some((m) => (m.payload as { betId: string }).betId === `r${sim.roundId}-win`);
        expect(updated).toBe(true);
        // a second cash_out for the same bet is no longer active
        sock.message({ type: 'cash_out', betId: `r${sim.roundId}-win` });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        expect((sock.framesOf('cashout_rejected')[0].payload as { reason: string }).reason).toBe(
            'not_active',
        );
    });

    it('rejects a cash_out arriving at/after the crash with reason crashed', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'ride', amount: 50 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        stepUntil(sim, () => sim.phase === 'crashed');
        sock.message({ type: 'cash_out', betId: `r${sim.roundId}-ride` });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        const rejected = sock.framesOf('cashout_rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0].payload as { reason: string }).reason).toBe('crashed');
    });

    it("rejects cashing out somebody else's bet with not_active", () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        stepUntil(sim, () => sim.phase === 'flight');
        const foreign = sim.getSnapshot().bets.find((b) => b.ownerConnId === null);
        if (!foreign) {
            throw new Error('expected the snapshot to contain a simulated bet');
        }
        sock.message({ type: 'cash_out', betId: foreign.id });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        expect((sock.framesOf('cashout_rejected')[0].payload as { reason: string }).reason).toBe(
            'not_active',
        );
    });

    it('answers malformed frames with error and keeps the connection alive', () => {
        const { gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        sock.message('this is not json');
        sock.message({ type: 42 });
        sock.message({ type: 'place_bet', clientBetId: '', amount: 'x' });
        expect(sock.framesOf('error')).toHaveLength(3);
        expect(sock.readyState).toBe(1);
        // still functional afterwards
        sock.message({ type: 'place_bet', clientBetId: 'ok', amount: 10 });
        vi.advanceTimersByTime(FLUSH_REPLIES);
        expect(sock.framesOf('bet_accepted')).toHaveLength(1);
    });

    it('a snapshot after reconnect reflects the live simulation state', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        stepUntil(sim, () => sim.phase === 'flight');
        for (let i = 0; i < 20 && sim.phase === 'flight'; i++) {
            sim.step();
        }
        if (sim.phase !== 'flight') {
            return;
        }
        gateway.handleDisconnect(sock.asWs());
        const sock2 = new FakeSocket();
        gateway.handleConnection(sock2.asWs());
        const snap = sock2.frames()[0];
        expect(snap.type).toBe('snapshot');
        expect(snap.seq).toBe(sim.seq);
        const round = (
            snap.payload as {
                round: { phase: string; multiplier: number; phaseEndsAt: number | null };
            }
        ).round;
        expect(round.phase).toBe('flight');
        expect(round.multiplier).toBe(sim.currentMultiplier());
        expect(round.phaseEndsAt).toBeNull();
        // feed resumes after the snapshot with seq strictly greater than the snapshot's
        sim.step();
        const next = sock2.frames()[1];
        expect(next.seq).toBeGreaterThan(snap.seq);
    });

    it('tears down subscriptions and pending timers on disconnect, flushing feed effects', () => {
        const { sim, gateway } = makeHarness();
        const sock = new FakeSocket();
        gateway.handleConnection(sock.asWs());
        const observer = new FakeSocket();
        gateway.handleConnection(observer.asWs());
        sock.message({ type: 'place_bet', clientBetId: 'ghost', amount: 10 });
        gateway.handleDisconnect(sock.asWs()); // before the reply latency elapses
        vi.advanceTimersByTime(FLUSH_REPLIES);
        const sentAfter = sock.framesOf('bet_accepted');
        expect(sentAfter).toHaveLength(0); // the reply died with the connection
        // ...but the feed announcement was flushed so other clients converge
        const ghostSeen = observer
            .framesOf('bets_placed')
            .some((m) =>
                (m.payload as { bets: Bet[] }).bets.some((b) => b.id === `r${sim.roundId}-ghost`),
            );
        expect(ghostSeen).toBe(true);
        const disconnectedCount = sock.sent.length;
        sim.step();
        expect(sock.sent.length).toBe(disconnectedCount); // unsubscribed from the feed
    });
});
