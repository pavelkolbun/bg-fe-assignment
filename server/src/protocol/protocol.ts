/**
 * Wire protocol — single source of truth for everything that crosses the socket.
 * Server-internal bookkeeping (cashout targets, owning connection) lives in the
 * simulation and is stripped before serialization.
 */

export interface ServerMessage<T extends string = string, P = unknown> {
    /**
     * Global counter incremented only when a broadcast feed message is produced.
     * Snapshots and direct replies carry the current value without incrementing —
     * they are not part of the ordered stream.
     */
    seq: number;
    /** Server epoch ms, after applying the configured clock offset. */
    serverTime: number;
    type: T;
    payload: P;
}

export interface Bet {
    id: string; // stable across the round, e.g. "r1284-p0917"
    player: string;
    amount: number; // 1.00 – 500.00, two decimals
    status: 'active' | 'cashed_out'; // deliberately no "lost" — clients derive it
    cashedAt: number | null; // multiplier at cashout, else null
    isYou?: boolean; // only on bets created via this connection's place_bet
}

export type Phase = 'betting' | 'flight' | 'crashed' | 'pause';

export interface RoundState {
    roundId: number;
    phase: Phase;
    multiplier: number; // flight: current · crashed/pause: crash multiplier · betting: 1.00
    phaseEndsAt: number | null; // null during flight — the crash is unpredictable
}

export type BetRejectReason = 'limit_exceeded' | 'round_closed' | 'wrong_phase';
export type CashoutRejectReason = 'crashed' | 'not_active' | 'wrong_phase';

export type SnapshotMsg = ServerMessage<
    'snapshot',
    { round: RoundState; bets: Bet[]; lastRounds: number[] }
>;
export type BettingOpenMsg = ServerMessage<'betting_open', { roundId: number; endsAt: number }>;
export type RoundStartMsg = ServerMessage<'round_start', { roundId: number; startedAt: number }>;
export type MultiplierTickMsg = ServerMessage<'multiplier_tick', { value: number }>;
export type RoundCrashMsg = ServerMessage<
    'round_crash',
    { roundId: number; crashMultiplier: number }
>;
export type BetsPlacedMsg = ServerMessage<'bets_placed', { bets: Bet[] }>;
export type BetUpdatedMsg = ServerMessage<
    'bet_updated',
    { betId: string; status: 'cashed_out'; cashedAt: number }
>;
export type BetAcceptedMsg = ServerMessage<'bet_accepted', { clientBetId: string; bet: Bet }>;
export type BetRejectedMsg = ServerMessage<
    'bet_rejected',
    { clientBetId: string; reason: BetRejectReason }
>;
export type CashoutAcceptedMsg = ServerMessage<
    'cashout_accepted',
    { betId: string; multiplier: number }
>;
export type CashoutRejectedMsg = ServerMessage<
    'cashout_rejected',
    { betId: string; reason: CashoutRejectReason }
>;
export type ErrorMsg = ServerMessage<'error', { message: string }>;

export type AnyServerMessage =
    | SnapshotMsg
    | BettingOpenMsg
    | RoundStartMsg
    | MultiplierTickMsg
    | RoundCrashMsg
    | BetsPlacedMsg
    | BetUpdatedMsg
    | BetAcceptedMsg
    | BetRejectedMsg
    | CashoutAcceptedMsg
    | CashoutRejectedMsg
    | ErrorMsg;

/** Client frames are bare JSON — no seq, no envelope. */
export interface PlaceBetCmd {
    type: 'place_bet';
    clientBetId: string;
    amount: number;
}

export interface CashOutCmd {
    type: 'cash_out';
    betId: string;
}

export type ClientCommand = PlaceBetCmd | CashOutCmd;
