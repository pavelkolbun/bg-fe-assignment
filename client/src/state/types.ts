import type { Phase } from '../ws/protocol';
import type { AnomalyEntry, ConnectionStatus, FeedStats } from '../ws/client';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  stats: FeedStats;
  anomalies: AnomalyEntry[];
}

export type BetRowStatus = 'active' | 'cashed_out' | 'pending' | 'rejected';

export interface BetView {
  id: string;
  player: string;
  amount: number;
  cashedAt: number | null;
  status: BetRowStatus;
  isYou: boolean;
}

/** What a row actually renders — 'lost' is derived, never stored on the bet itself. */
export type DisplayStatus = 'active' | 'cashed_out' | 'lost' | 'pending' | 'rejected';

export interface RoundSnapshot {
  roundId: number;
  phase: Phase;
  phaseEndsAt: number | null;
  crashMultiplier: number | null;
  lastRounds: number[];
}

export interface TickerAnchor {
  value: number;
  serverTime: number;
  phase: Phase;
}

export type YourBetStatus =
  | 'idle'
  | 'pending'
  | 'active'
  | 'cashing_out'
  | 'cashed_out'
  | 'rejected'
  | 'lost';

export interface YourBetSnapshot {
  status: YourBetStatus;
  clientBetId: string | null;
  betId: string | null;
  amount: number | null;
  cashedAt: number | null;
  rejectReason: string | null;
}
