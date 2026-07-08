// client/src/ws/client.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedClient, type FeedClientHandlers, type FeedStats } from './client';

/**
 * Minimal stand-in for the browser WebSocket the client dispatches against.
 * Tests drive it manually (open/message/close) instead of a real socket.
 */
type MockEvent = { data?: string; code?: number };
type MockListener = (event: MockEvent) => void;

class MockSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<MockListener>>();

  constructor(public url: string) {
    instances.push(this);
  }

  addEventListener(type: string, cb: MockListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockSocket.CLOSED;
  }

  // ---- test-only helpers, simulating the server side ----
  open(): void {
    this.readyState = MockSocket.OPEN;
    this.listeners.get('open')?.forEach((cb) => cb({}));
  }

  message(payload: unknown): void {
    this.listeners.get('message')?.forEach((cb) => cb({ data: JSON.stringify(payload) }));
  }

  serverClose(): void {
    this.readyState = MockSocket.CLOSED;
    this.listeners.get('close')?.forEach((cb) => cb({ code: 1006 }));
  }
}

let instances: MockSocket[] = [];

function lastSocket(): MockSocket {
  const s = instances.at(-1);
  if (!s) throw new Error('no socket created yet');
  return s;
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onFeed: vi.fn(),
    onReply: vi.fn(),
    onStats: vi.fn(),
    onAnomaly: vi.fn(),
  } satisfies FeedClientHandlers;
}

function lastStats(handlers: ReturnType<typeof makeHandlers>): FeedStats {
  const calls = handlers.onStats.mock.calls;
  const last = calls.at(-1);
  if (!last) throw new Error('onStats was never called');
  return last[0];
}

beforeEach(() => {
  instances = [];
  vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

describe('FeedClient — sequencing', () => {
  it('applies a snapshot and resets the seq window to it', () => {
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();

    lastSocket().message({
      seq: 100,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: {
        round: { roundId: 1, phase: 'betting', multiplier: 1, phaseEndsAt: null },
        bets: [],
        lastRounds: [],
      },
    });

    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1);
    expect(handlers.onStatus).toHaveBeenCalledWith('live');
    expect(lastStats(handlers).lastSeq).toBe(100);
  });

  it('drops an exact duplicate seq and counts it', () => {
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();
    lastSocket().message({
      seq: 1,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });

    const tick = { seq: 2, serverTime: Date.now(), type: 'multiplier_tick', payload: { value: 1.5 } };
    lastSocket().message(tick);
    lastSocket().message(tick); // exact duplicate, same seq

    expect(handlers.onFeed).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers).duplicates).toBe(1);
  });

  it('detects a gap, then fixes the reorder once the delayed message lands', () => {
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();
    lastSocket().message({
      seq: 1,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });

    // seq 3 arrives before seq 2 (2 got held back by reorder chaos)
    lastSocket().message({ seq: 3, serverTime: Date.now(), type: 'multiplier_tick', payload: { value: 1.1 } });
    expect(lastStats(handlers).gapsDetected).toBe(1);

    // the held-back message finally arrives
    lastSocket().message({ seq: 2, serverTime: Date.now(), type: 'multiplier_tick', payload: { value: 1.05 } });
    expect(lastStats(handlers).outOfOrderFixed).toBe(1);

    // both were still delivered to the app, not silently dropped
    expect(handlers.onFeed).toHaveBeenCalledTimes(2);
  });

  it('does not treat direct replies (bet_accepted etc.) as part of the seq stream', () => {
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();
    lastSocket().message({
      seq: 5,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });

    // a reply can legitimately share a seq with a feed message - must not count as a dup
    lastSocket().message({ seq: 5, serverTime: Date.now(), type: 'bet_accepted', payload: { clientBetId: 'c-1', bet: {} } });

    expect(handlers.onReply).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers).duplicates).toBe(0);
  });
});

describe('FeedClient — clock drift', () => {
  it('estimates drift as the median of serverTime - Date.now() samples', () => {
    vi.setSystemTime(0);
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();

    // serverTime is always 100ms ahead of local time in every sample - advance
    // the fake clock between messages so each sample actually reflects that.
    lastSocket().message({
      seq: 1,
      serverTime: 100,
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });
    vi.setSystemTime(100);
    lastSocket().message({ seq: 2, serverTime: 200, type: 'multiplier_tick', payload: { value: 1.1 } });

    expect(lastStats(handlers).driftMs).toBe(100);
  });
});

describe('FeedClient — reconnect', () => {
  it('reconnects with exponential backoff and recovers via a fresh snapshot', () => {
    const handlers = makeHandlers();
    new FeedClient('ws://test', handlers).connect();
    lastSocket().open();
    lastSocket().message({
      seq: 1,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });

    lastSocket().serverClose(); // simulates the server's forced 1006 drop
    expect(handlers.onStatus).toHaveBeenCalledWith('reconnecting');

    vi.advanceTimersByTime(300); // BACKOFF_START_MS
    expect(instances).toHaveLength(2); // a new socket was opened

    lastSocket().open();
    expect(handlers.onStatus).toHaveBeenCalledWith('recovering');

    lastSocket().message({
      seq: 50,
      serverTime: Date.now(),
      type: 'snapshot',
      payload: { round: {}, bets: [], lastRounds: [] },
    });
    expect(handlers.onStatus).toHaveBeenCalledWith('live');
    expect(lastStats(handlers).reconnects).toBe(1);
  });

  it('send() is a no-op while the socket is not open', () => {
    const handlers = makeHandlers();
    const client = new FeedClient('ws://test', handlers);
    client.connect();
    // socket exists but hasn't opened yet
    client.send({ type: 'place_bet', clientBetId: 'c-1', amount: 10 });
    expect(lastSocket().sent).toHaveLength(0);
  });
});