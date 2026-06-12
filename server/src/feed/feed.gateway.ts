import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import type { RawData, WebSocket } from 'ws';
import { ChaosPipeline } from '../chaos/chaos-pipeline';
import { AppConfig, CLOCK, Clock, CONFIG } from '../config/config';
import { Bet, BetRejectReason, CashoutRejectReason } from '../protocol/protocol';
import { RNG, Rng } from '../rng/rng.provider';
import { BetRecord, FeedMessage, SimulationService } from '../simulation/simulation.service';

const WS_OPEN = 1;

interface Connection {
    id: number;
    socket: WebSocket;
    pipeline: ChaosPipeline;
    subscription: Subscription;
    /** Command-side RNG stream (reject rolls, reply latency) — never touches the simulation's. */
    rng: Rng;
    /** Pending delayed replies; value is the feed side-effect to flush on teardown. */
    timers: Map<NodeJS.Timeout, () => void>;
}

/**
 * One gateway, raw wire protocol. No @SubscribeMessage — we attach our own
 * `message` listener per socket so the frames are exactly our bare JSON
 * shapes, with nothing of Nest visible on the wire.
 */
@WebSocketGateway()
export class FeedGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger('Feed');
    private readonly connections = new Map<WebSocket, Connection>();
    private connCounter = 0;

    constructor(
        @Inject(CONFIG) private readonly config: AppConfig,
        @Inject(RNG) private readonly masterRng: Rng,
        @Inject(CLOCK) private readonly clock: Clock,
        private readonly simulation: SimulationService,
    ) {}

    handleConnection(socket: WebSocket): void {
        const id = ++this.connCounter;
        const pipeline = new ChaosPipeline(this.config, this.masterRng.fork(`conn-${id}-chaos`), {
            deliver: (frame) => this.sendRaw(socket, frame),
            forceDrop: () => {
                this.logger.log(
                    `conn#${id} forced drop (terminate — client observes close code 1006)`,
                );
                socket.terminate();
            },
            debug: this.config.verbose
                ? (msg) => this.logger.debug(`conn#${id} chaos: ${msg}`)
                : undefined,
        });
        const conn: Connection = {
            id,
            socket,
            pipeline,
            rng: this.masterRng.fork(`conn-${id}-cmd`),
            timers: new Map(),
            subscription: Subscription.EMPTY,
        };
        this.connections.set(socket, conn);

        // Snapshot, then subscribe, in one synchronous block: Subject delivery is
        // synchronous, so no feed message can fall between the two.
        this.sendDirect(conn, 'snapshot', this.snapshotPayload(conn));
        conn.subscription = this.simulation.feed$.subscribe((msg) =>
            pipeline.push(this.serializeFeed(msg, conn.id)),
        );

        socket.on('message', (data) => this.onClientFrame(conn, data));
        this.logger.log(`conn#${id} connected (${this.connections.size} active)`);
    }

    handleDisconnect(socket: WebSocket): void {
        const conn = this.connections.get(socket);
        if (!conn) {
            return;
        }
        this.connections.delete(socket);
        conn.subscription.unsubscribe();
        conn.pipeline.destroy();
        // Replies die with the connection, but accepted state is already in the
        // simulation — flush the feed announcements so other clients stay consistent.
        for (const [timer, feedEffect] of conn.timers) {
            clearTimeout(timer);
            feedEffect();
        }
        conn.timers.clear();
        this.logger.log(`conn#${conn.id} disconnected (${this.connections.size} active)`);
    }

    private onClientFrame(conn: Connection, data: RawData): void {
        const text = data.toString();
        if (this.config.verbose) {
            this.logger.debug(`conn#${conn.id} -> ${text}`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.sendDirect(conn, 'error', { message: 'invalid JSON' });
            return;
        }
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as { type?: unknown }).type !== 'string'
        ) {
            this.sendDirect(conn, 'error', {
                message: 'expected a JSON object with a string "type" field',
            });
            return;
        }
        const cmd = parsed as Record<string, unknown>;
        switch (cmd.type) {
            case 'place_bet':
                this.handlePlaceBet(conn, cmd);
                return;
            case 'cash_out':
                this.handleCashOut(conn, cmd);
                return;
            default:
                this.sendDirect(conn, 'error', {
                    message: `unknown command type "${String(cmd.type)}"`,
                });
        }
    }

    /** All rules are judged at receipt; only the reply (and feed effect) is delayed. */
    private handlePlaceBet(conn: Connection, cmd: Record<string, unknown>): void {
        const { clientBetId, amount } = cmd;
        if (
            typeof clientBetId !== 'string' ||
            clientBetId.length === 0 ||
            clientBetId.length > 64
        ) {
            this.sendDirect(conn, 'error', {
                message: 'place_bet: clientBetId must be a non-empty string (max 64 chars)',
            });
            return;
        }
        if (typeof amount !== 'number' || !Number.isFinite(amount)) {
            this.sendDirect(conn, 'error', {
                message: 'place_bet: amount must be a finite number',
            });
            return;
        }
        const phase = this.simulation.phase;
        if (phase !== 'betting') {
            const reason: BetRejectReason = phase === 'flight' ? 'round_closed' : 'wrong_phase';
            this.replyLater(conn, 'bet_rejected', () => ({ clientBetId, reason }));
            return;
        }
        if (amount < 1 || amount > 500) {
            this.replyLater(conn, 'bet_rejected', () => ({
                clientBetId,
                reason: 'limit_exceeded' as const,
            }));
            return;
        }
        if (this.simulation.hasBet(`r${this.simulation.roundId}-${clientBetId}`)) {
            this.sendDirect(conn, 'error', {
                message: `clientBetId "${clientBetId}" was already used this round`,
            });
            return;
        }
        if (conn.rng.next() < this.config.rejectRate) {
            this.replyLater(conn, 'bet_rejected', () => ({
                clientBetId,
                reason: 'limit_exceeded' as const,
            }));
            return;
        }
        const record = this.simulation.addClientBet(conn.id, clientBetId, amount);
        this.replyLater(
            conn,
            'bet_accepted',
            () => ({ clientBetId, bet: this.toWireBet(record, conn.id) }),
            () => this.simulation.emitClientBet(record),
        );
    }

    private handleCashOut(conn: Connection, cmd: Record<string, unknown>): void {
        const { betId } = cmd;
        if (typeof betId !== 'string' || betId.length === 0) {
            this.sendDirect(conn, 'error', {
                message: 'cash_out: betId must be a non-empty string',
            });
            return;
        }
        const phase = this.simulation.phase;
        const record = this.simulation.getBet(betId);
        const ownActive =
            record !== undefined && record.ownerConnId === conn.id && record.status === 'active';
        if (phase === 'flight') {
            if (!ownActive) {
                this.replyLater(conn, 'cashout_rejected', () => ({
                    betId,
                    reason: 'not_active' as const,
                }));
                return;
            }
            const multiplier = this.simulation.cashOutNow(record);
            this.replyLater(
                conn,
                'cashout_accepted',
                () => ({ betId, multiplier }),
                () => this.simulation.emitCashout(record),
            );
            return;
        }
        if (phase === 'betting') {
            this.replyLater(conn, 'cashout_rejected', () => ({
                betId,
                reason: 'wrong_phase' as const,
            }));
            return;
        }
        // crashed | pause: an own bet that was still active when the round crashed lost the race
        const reason: CashoutRejectReason = ownActive ? 'crashed' : 'not_active';
        this.replyLater(conn, 'cashout_rejected', () => ({ betId, reason }));
    }

    private replyLater(
        conn: Connection,
        type: string,
        payload: () => unknown,
        feedEffect: () => void = () => undefined,
    ): void {
        const delay = Math.round(conn.rng.uniform(200, 800));
        const timer = setTimeout(() => {
            conn.timers.delete(timer);
            feedEffect();
            this.sendDirect(conn, type, payload());
        }, delay);
        conn.timers.set(timer, feedEffect);
    }

    /** Direct sends (snapshot, replies, errors) bypass chaos and do not increment seq. */
    private sendDirect(conn: Connection, type: string, payload: unknown): void {
        this.sendRaw(
            conn.socket,
            JSON.stringify({ seq: this.simulation.seq, serverTime: this.clock(), type, payload }),
        );
    }

    private sendRaw(socket: WebSocket, frame: string): void {
        if (socket.readyState === WS_OPEN) {
            socket.send(frame);
        }
    }

    private snapshotPayload(conn: Connection): {
        round: unknown;
        bets: Bet[];
        lastRounds: number[];
    } {
        const snapshot = this.simulation.getSnapshot();
        return {
            round: snapshot.round,
            bets: snapshot.bets.map((b) => this.toWireBet(b, conn.id)),
            lastRounds: snapshot.lastRounds,
        };
    }

    /** Per-connection serialization: this is where isYou is attached and internal fields are stripped. */
    private serializeFeed(msg: FeedMessage, connId: number): string {
        const payload =
            msg.type === 'bets_placed'
                ? { bets: msg.payload.bets.map((b) => this.toWireBet(b, connId)) }
                : msg.payload;
        return JSON.stringify({
            seq: msg.seq,
            serverTime: msg.serverTime,
            type: msg.type,
            payload,
        });
    }

    private toWireBet(record: BetRecord, connId: number): Bet {
        const bet: Bet = {
            id: record.id,
            player: record.player,
            amount: record.amount,
            status: record.status,
            cashedAt: record.cashedAt,
        };
        if (record.ownerConnId === connId) {
            bet.isYou = true;
        }
        return bet;
    }
}
