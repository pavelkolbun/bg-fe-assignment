import type { AnomalyEntry, ConnectionStatus, FeedClientHandlers, FeedStats } from '../ws/client';
import type {
  AnyServerMessage,
  BetsPlacedMsg,
  BetUpdatedMsg,
  FeedMessage, Phase,
  RoundStartMsg,
  SnapshotMsg,
  WireBet,
} from '../ws/protocol';
import type {BetView, DisplayStatus, RoundSnapshot, TickerAnchor, YourBetSnapshot} from './types';

type Listener = () => void;
type TickerListener = (anchor: TickerAnchor) => void;

const MAX_ANOMALIES = 50;
const LAST_ROUNDS_SHOWN = 6;

function mapWireBet(bet: WireBet): BetView {
  return {
    id: bet.id,
    player: bet.player,
    amount: bet.amount,
    cashedAt: bet.cashedAt,
    status: bet.status,
    isYou: bet.isYou ?? false,
  };
}

export function deriveDisplayStatus(bet: BetView, roundPhase: Phase): DisplayStatus {
  if (bet.status === 'active' && (roundPhase === 'crashed' || roundPhase === 'pause')) {
    return 'lost';
  }
  return bet.status;
}

/**
 * Single source of truth for everything the UI renders. Deliberately not a
 * React context/reducer: per-bet row subscriptions need to be O(1) to look up
 * and notify independently of the other 4,999 rows, which a normal
 * useState/useReducer re-render model can't give us. Consumed via
 * useSyncExternalStore in src/state/hooks.ts.
 */
export class Store {
  // ---- bets table -------------------------------------------------------
  private bets = new Map<string, BetView>();
  private order: string[] = [];
  private rowListeners = new Map<string, Set<Listener>>();
  private orderListeners = new Set<Listener>();
  private pendingRowIds = new Set<string>();
  private orderDirty = false;
  private rafHandle: number | null = null;

  // ---- round / ticker -----------------------------------------------------
  private round: RoundSnapshot = {
    roundId: 0,
    phase: 'pause',
    phaseEndsAt: null,
    crashMultiplier: null,
    lastRounds: [],
  };
  private roundListeners = new Set<Listener>();
  private tickerAnchor: TickerAnchor = { value: 1, serverTime: 0, phase: 'pause' };
  private tickerListeners = new Set<TickerListener>();

  // ---- connection ---------------------------------------------------------
  private connectionStatus: ConnectionStatus = 'connecting';
  private stats: FeedStats = {
    lastSeq: 0,
    duplicates: 0,
    outOfOrderFixed: 0,
    gapsDetected: 0,
    reconnects: 0,
    driftMs: 0,
  };
  private anomalies: AnomalyEntry[] = [];
  private connectionListeners = new Set<Listener>();

  // ---- your bet -----------------------------------------------------------
  private yourBet: YourBetSnapshot = {
    status: 'idle',
    clientBetId: null,
    betId: null,
    amount: null,
    cashedAt: null,
    rejectReason: null,
  };
  private yourBetListeners = new Set<Listener>();

  // === row subscriptions ===================================================

  subscribeRow = (id: string) => (cb: Listener): (() => void) => {
    let set = this.rowListeners.get(id);
    if (!set) {
      set = new Set();
      this.rowListeners.set(id, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.rowListeners.delete(id);
    };
  };

  getRowSnapshot = (id: string): BetView | undefined => this.bets.get(id);

  subscribeOrder = (cb: Listener): (() => void) => {
    this.orderListeners.add(cb);
    return () => this.orderListeners.delete(cb);
  };

  getOrderSnapshot = (): readonly string[] => this.order;

  // === round ================================================================

  subscribeRound = (cb: Listener): (() => void) => {
    this.roundListeners.add(cb);
    return () => this.roundListeners.delete(cb);
  };

  getRoundSnapshot = (): RoundSnapshot => this.round;

  /** Push-based (not useSyncExternalStore) — the ticker animates via rAF off a ref, not React state. */
  subscribeTicker = (cb: TickerListener): (() => void) => {
    this.tickerListeners.add(cb);
    return () => this.tickerListeners.delete(cb);
  };

  getTickerAnchor = (): TickerAnchor => this.tickerAnchor;

  // === connection ============================================================

  subscribeConnection = (cb: Listener): (() => void) => {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  };

  getConnectionSnapshot = () => ({
    status: this.connectionStatus,
    stats: this.stats,
    anomalies: this.anomalies,
  });

  // === your bet ==============================================================

  subscribeYourBet = (cb: Listener): (() => void) => {
    this.yourBetListeners.add(cb);
    return () => this.yourBetListeners.delete(cb);
  };

  getYourBetSnapshot = (): YourBetSnapshot => this.yourBet;

  // === mutation helpers (bets) ===============================================

  private upsertBet(view: BetView): void {
    const existing = this.bets.get(view.id);
    this.bets.set(view.id, existing ? { ...existing, ...view } : view);
    if (!existing) {
      this.order.push(view.id);
      this.orderDirty = true;
    }
    this.pendingRowIds.add(view.id);
    this.scheduleFlush();
  }

  private removeBet(id: string): void {
    if (!this.bets.has(id)) return;
    this.bets.delete(id);
    const idx = this.order.indexOf(id);
    if (idx !== -1) this.order.splice(idx, 1);
    this.pendingRowIds.delete(id);
    this.orderDirty = true;
    this.scheduleFlush();
  }

  private replaceAllBets(views: BetView[]): void {
    this.bets = new Map(views.map((v) => [v.id, v]));
    this.order = views.map((v) => v.id);
    this.pendingRowIds.clear();
    this.orderDirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.rafHandle = null;
    if (this.orderDirty) {
      this.orderDirty = false;
      this.orderListeners.forEach((cb) => cb());
    }
    if (this.pendingRowIds.size > 0) {
      const ids = this.pendingRowIds;
      this.pendingRowIds = new Set();
      for (const id of ids) {
        this.rowListeners.get(id)?.forEach((cb) => cb());
      }
    }
  }

  // === mutation helpers (round/ticker) =======================================

  private setRound(patch: Partial<RoundSnapshot>): void {
    this.round = { ...this.round, ...patch };
    this.roundListeners.forEach((cb) => cb());
  }

  private setTicker(anchor: TickerAnchor): void {
    this.tickerAnchor = anchor;
    this.tickerListeners.forEach((cb) => cb(anchor));
  }

  // === mutation helpers (connection) =========================================

  private notifyConnection(): void {
    this.connectionListeners.forEach((cb) => cb());
  }

  private pushAnomaly(entry: AnomalyEntry): void {
    this.anomalies = [entry, ...this.anomalies].slice(0, MAX_ANOMALIES);
  }

  // === mutation helpers (your bet) ===========================================

  private setYourBet(patch: Partial<YourBetSnapshot>): void {
    this.yourBet = { ...this.yourBet, ...patch };
    this.yourBetListeners.forEach((cb) => cb());
  }

  // === public command-side API (called by the bet panel) ====================

  placeBetOptimistic(clientBetId: string, amount: number): void {
    const pendingId = `pending:${clientBetId}`;
    this.upsertBet({
      id: pendingId,
      player: 'you',
      amount,
      cashedAt: null,
      status: 'pending',
      isYou: true,
    });
    this.setYourBet({
      status: 'pending',
      clientBetId,
      betId: null,
      amount,
      cashedAt: null,
      rejectReason: null,
    });
  }

  markCashingOut(): void {
    if (this.yourBet.status === 'active') {
      this.setYourBet({ status: 'cashing_out' });
    }
  }

  // === feed client wiring =====================================================

  /** Handlers passed straight to `new FeedClient(url, handlers)`. */
  handlers: FeedClientHandlers = {
    onStatus: (status: ConnectionStatus) => {
      this.connectionStatus = status;
      this.notifyConnection();
    },
    onStats: (stats: FeedStats) => {
      this.stats = stats;
      this.notifyConnection();
    },
    onAnomaly: (entry: AnomalyEntry) => {
      this.pushAnomaly(entry);
      this.notifyConnection();
    },
    onSnapshot: (msg: SnapshotMsg) => this.applySnapshot(msg),
    onFeed: (msg: FeedMessage) => this.applyFeed(msg),
    onReply: (msg: AnyServerMessage) => this.applyReply(msg),
  };

  private applySnapshot(msg: SnapshotMsg): void {
    const { round, bets, lastRounds } = msg.payload;
    this.replaceAllBets(bets.map(mapWireBet));
    this.setRound({
      roundId: round.roundId,
      phase: round.phase,
      phaseEndsAt: round.phaseEndsAt,
      crashMultiplier: round.phase === 'crashed' || round.phase === 'pause' ? round.multiplier : null,
      lastRounds: lastRounds.slice(0, LAST_ROUNDS_SHOWN),
    });
    this.setTicker({ value: round.multiplier, serverTime: msg.serverTime, phase: round.phase });

    const mine = bets.find((b) => b.isYou);
    if (mine) {
      this.setYourBet({
        status: mine.status === 'cashed_out' ? 'cashed_out' : 'active',
        clientBetId: this.yourBet.clientBetId,
        betId: mine.id,
        amount: mine.amount,
        cashedAt: mine.cashedAt,
        rejectReason: null,
      });
    } else if (this.yourBet.status === 'pending' || this.yourBet.status === 'cashing_out') {
      // We had something in flight when the connection dropped and the snapshot
      // doesn't confirm it — the snapshot wins, so we can't assume it landed.
      this.setYourBet({
        status: 'idle',
        clientBetId: null,
        betId: null,
        amount: null,
        cashedAt: null,
        rejectReason: null,
      });
    }
  }

  private applyFeed(msg: FeedMessage): void {
    switch (msg.type) {
      case 'betting_open':
        this.replaceAllBets([]);
        this.setRound({
          roundId: msg.payload.roundId,
          phase: 'betting',
          phaseEndsAt: msg.payload.endsAt,
          crashMultiplier: null,
        });
        this.setTicker({ value: 1, serverTime: msg.serverTime, phase: 'betting' });
        this.setYourBet({
          status: 'idle',
          clientBetId: null,
          betId: null,
          amount: null,
          cashedAt: null,
          rejectReason: null,
        });
        return;
      case 'round_start':
        this.applyRoundStart(msg);
        return;
      case 'multiplier_tick':
        this.setTicker({ value: msg.payload.value, serverTime: msg.serverTime, phase: 'flight' });
        return;
      case 'round_crash':
        this.setRound({
          phase: 'crashed',
          crashMultiplier: msg.payload.crashMultiplier,
          lastRounds: [msg.payload.crashMultiplier, ...this.round.lastRounds].slice(
            0,
            LAST_ROUNDS_SHOWN,
          ),
        });
        this.setTicker({
          value: msg.payload.crashMultiplier,
          serverTime: msg.serverTime,
          phase: 'crashed',
        });
        if (this.yourBet.status === 'active') {
          this.setYourBet({ status: 'lost' });
        }
        return;
      case 'bets_placed':
        this.applyBetsPlaced(msg);
        return;
      case 'bet_updated':
        this.applyBetUpdated(msg);
        return;
    }
  }

  private applyRoundStart(msg: RoundStartMsg): void {
    this.setRound({ phase: 'flight', phaseEndsAt: null });
    this.setTicker({ value: 1, serverTime: msg.serverTime, phase: 'flight' });
  }

  private applyBetsPlaced(msg: BetsPlacedMsg): void {
    for (const bet of msg.payload.bets) {
      this.upsertBet(mapWireBet(bet));
    }
  }

  private applyBetUpdated(msg: BetUpdatedMsg): void {
    const existing = this.bets.get(msg.payload.betId);
    if (!existing) return; // extremely rare reorder edge case — see DECISIONS.md
    this.upsertBet({ ...existing, status: 'cashed_out', cashedAt: msg.payload.cashedAt });
    if (this.yourBet.betId === msg.payload.betId) {
      this.setYourBet({ status: 'cashed_out', cashedAt: msg.payload.cashedAt });
    }
  }

  private applyReply(msg: AnyServerMessage): void {
    switch (msg.type) {
      case 'bet_accepted': {
        const { clientBetId, bet } = msg.payload;
        this.removeBet(`pending:${clientBetId}`);
        this.upsertBet(mapWireBet(bet));
        if (this.yourBet.clientBetId === clientBetId) {
          this.setYourBet({ status: 'active', betId: bet.id, amount: bet.amount, cashedAt: null });
        }
        return;
      }
      case 'bet_rejected': {
        const { clientBetId, reason } = msg.payload;
        this.removeBet(`pending:${clientBetId}`);
        if (this.yourBet.clientBetId === clientBetId) {
          this.setYourBet({ status: 'rejected', rejectReason: reason });
        }
        return;
      }
      case 'cashout_accepted': {
        const { betId, multiplier } = msg.payload;
        const existing = this.bets.get(betId);
        if (existing) this.upsertBet({ ...existing, status: 'cashed_out', cashedAt: multiplier });
        if (this.yourBet.betId === betId) {
          this.setYourBet({ status: 'cashed_out', cashedAt: multiplier });
        }
        return;
      }
      case 'cashout_rejected': {
        const { betId, reason } = msg.payload;
        if (this.yourBet.betId !== betId) return;
        if (reason === 'crashed') {
          this.setYourBet({ status: 'lost' });
        } else if (reason === 'wrong_phase') {
          this.setYourBet({ status: 'active' });
        }
        // 'not_active' — stale click on an already-resolved bet; nothing to do.
        return;
      }
      default:
        return;
    }
  }
}
