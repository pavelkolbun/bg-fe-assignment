import type { AnyServerMessage, ClientCommand, FeedMessage, SnapshotMsg } from './protocol';
import { isFeedMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'recovering';

export interface FeedStats {
  lastSeq: number;
  duplicates: number;
  outOfOrderFixed: number;
  gapsDetected: number;
  reconnects: number;
  driftMs: number;
}

export interface AnomalyEntry {
  time: number;
  kind: 'duplicate' | 'reorder' | 'gap' | 'reconnect' | 'resync';
  message: string;
}

export interface FeedClientHandlers {
  onStatus: (status: ConnectionStatus) => void;
  onSnapshot: (msg: SnapshotMsg) => void;
  onFeed: (msg: FeedMessage) => void;
  onReply: (msg: AnyServerMessage) => void;
  onStats: (stats: FeedStats) => void;
  onAnomaly: (entry: AnomalyEntry) => void;
}

const RECENT_WINDOW = 512;
const DRIFT_SAMPLE_WINDOW = 40;
const BACKOFF_START_MS = 300;
const BACKOFF_MAX_MS = 5000;

/**
 * Owns the raw WebSocket, reconnect/backoff, seq dedupe + gap accounting, and
 * clock-offset estimation. Emits high-level, already-reconciled events via
 * `handlers` — nothing above this layer needs to know about chaos.
 */
export class FeedClient {
  private ws: WebSocket | null = null;
  private manuallyClosed = false;
  private everConnected = false;
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private expectedSeq = -1;
  private recentSeqs: number[] = [];
  private recentSeqSet = new Set<number>();

  private driftSamples: number[] = [];

  private stats: FeedStats = {
    lastSeq: 0,
    duplicates: 0,
    outOfOrderFixed: 0,
    gapsDetected: 0,
    reconnects: 0,
    driftMs: 0,
  };

  constructor(
    private readonly url: string,
    private readonly handlers: FeedClientHandlers,
  ) {}

  connect(): void {
    this.manuallyClosed = false;
    this.open();
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  private open(): void {
    this.handlers.onStatus(this.everConnected ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.everConnected) {
        this.stats.reconnects++;
        this.pushAnomaly('reconnect', `reconnected (attempt backoff was ${this.backoffMs}ms)`);
        this.publishStats();
      }
      this.everConnected = true;
      this.backoffMs = BACKOFF_START_MS;
      this.handlers.onStatus('recovering');
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      this.handleFrame(event.data);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // stale socket, already replaced
      this.ws = null;
      if (this.manuallyClosed) return;
      this.handlers.onStatus('reconnecting');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' always follows 'error' for browser WebSocket — no separate handling needed.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleFrame(raw: string): void {
    let msg: AnyServerMessage;
    try {
      msg = JSON.parse(raw) as AnyServerMessage;
    } catch {
      return;
    }

    this.sampleDrift(msg.serverTime);

    if (msg.type === 'snapshot') {
      this.resyncFromSnapshot(msg as SnapshotMsg);
      return;
    }

    if (!isFeedMessage(msg)) {
      // direct replies (bet_accepted, bet_rejected, cashout_*, error) — not part of the ordered stream
      this.handlers.onReply(msg);
      return;
    }

    this.processFeedMessage(msg);
  }

  private resyncFromSnapshot(msg: SnapshotMsg): void {
    this.expectedSeq = msg.seq + 1;
    this.recentSeqs = [msg.seq];
    this.recentSeqSet = new Set([msg.seq]);
    this.stats.lastSeq = msg.seq;
    this.pushAnomaly('resync', `snapshot received at seq ${msg.seq} — state reset to server truth`);
    this.handlers.onSnapshot(msg);
    this.handlers.onStatus('live');
    this.publishStats();
  }

  private processFeedMessage(msg: FeedMessage): void {
    const { seq } = msg;

    if (this.recentSeqSet.has(seq)) {
      this.stats.duplicates++;
      this.pushAnomaly('duplicate', `seq ${seq} (${msg.type}) — duplicate dropped`);
      this.publishStats();
      return;
    }

    if (this.expectedSeq === -1) {
      this.expectedSeq = seq + 1;
    } else if (seq === this.expectedSeq) {
      this.expectedSeq = seq + 1;
    } else if (seq > this.expectedSeq) {
      this.stats.gapsDetected++;
      this.pushAnomaly(
        'gap',
        `gap before seq ${seq} — missing ${this.expectedSeq}..${seq - 1}, expecting late delivery`,
      );
      this.expectedSeq = seq + 1;
    } else {
      // seq < expectedSeq and not a known duplicate: a delayed message filling an earlier gap.
      this.stats.outOfOrderFixed++;
      this.pushAnomaly('reorder', `seq ${seq} (${msg.type}) arrived late — reordered into place`);
    }

    this.markSeqProcessed(seq);
    this.stats.lastSeq = Math.max(this.stats.lastSeq, seq);
    this.publishStats();
    this.handlers.onFeed(msg);
  }

  private markSeqProcessed(seq: number): void {
    this.recentSeqSet.add(seq);
    this.recentSeqs.push(seq);
    if (this.recentSeqs.length > RECENT_WINDOW) {
      const old = this.recentSeqs.shift();
      if (old !== undefined) this.recentSeqSet.delete(old);
    }
  }

  private sampleDrift(serverTime: number): void {
    const sample = serverTime - Date.now();
    this.driftSamples.push(sample);
    if (this.driftSamples.length > DRIFT_SAMPLE_WINDOW) {
      this.driftSamples.shift();
    }
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
    this.stats.driftMs = Math.round(median);
  }

  private publishStats(): void {
    this.handlers.onStats({ ...this.stats });
  }

  private pushAnomaly(kind: AnomalyEntry['kind'], message: string): void {
    this.handlers.onAnomaly({ time: Date.now(), kind, message });
  }
}
