/** Wire protocol types — mirrors server/src/protocol/protocol.ts (client has no dependency on the server package). */

export interface ServerEnvelope<T extends string = string, P = unknown> {
  seq: number;
  serverTime: number;
  type: T;
  payload: P;
}

export interface WireBet {
  id: string;
  player: string;
  amount: number;
  status: 'active' | 'cashed_out';
  cashedAt: number | null;
  isYou?: boolean;
}

export type Phase = 'betting' | 'flight' | 'crashed' | 'pause';

export interface RoundState {
  roundId: number;
  phase: Phase;
  multiplier: number;
  phaseEndsAt: number | null;
}

export type BetRejectReason = 'limit_exceeded' | 'round_closed' | 'wrong_phase';
export type CashoutRejectReason = 'crashed' | 'not_active' | 'wrong_phase';

export type SnapshotMsg = ServerEnvelope<
  'snapshot',
  { round: RoundState; bets: WireBet[]; lastRounds: number[] }
>;
export type BettingOpenMsg = ServerEnvelope<'betting_open', { roundId: number; endsAt: number }>;
export type RoundStartMsg = ServerEnvelope<'round_start', { roundId: number; startedAt: number }>;
export type MultiplierTickMsg = ServerEnvelope<'multiplier_tick', { value: number }>;
export type RoundCrashMsg = ServerEnvelope<
  'round_crash',
  { roundId: number; crashMultiplier: number }
>;
export type BetsPlacedMsg = ServerEnvelope<'bets_placed', { bets: WireBet[] }>;
export type BetUpdatedMsg = ServerEnvelope<
  'bet_updated',
  { betId: string; status: 'cashed_out'; cashedAt: number }
>;
export type BetAcceptedMsg = ServerEnvelope<'bet_accepted', { clientBetId: string; bet: WireBet }>;
export type BetRejectedMsg = ServerEnvelope<
  'bet_rejected',
  { clientBetId: string; reason: BetRejectReason }
>;
export type CashoutAcceptedMsg = ServerEnvelope<
  'cashout_accepted',
  { betId: string; multiplier: number }
>;
export type CashoutRejectedMsg = ServerEnvelope<
  'cashout_rejected',
  { betId: string; reason: CashoutRejectReason }
>;
export type ErrorMsg = ServerEnvelope<'error', { message: string }>;

export type FeedMessage =
  | BettingOpenMsg
  | RoundStartMsg
  | MultiplierTickMsg
  | RoundCrashMsg
  | BetsPlacedMsg
  | BetUpdatedMsg;

export type AnyServerMessage =
  | SnapshotMsg
  | FeedMessage
  | BetAcceptedMsg
  | BetRejectedMsg
  | CashoutAcceptedMsg
  | CashoutRejectedMsg
  | ErrorMsg;

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

const FEED_TYPES = new Set<string>([
  'betting_open',
  'round_start',
  'multiplier_tick',
  'round_crash',
  'bets_placed',
  'bet_updated',
]);

export function isFeedMessage(msg: AnyServerMessage): msg is FeedMessage {
  return FEED_TYPES.has(msg.type);
}
