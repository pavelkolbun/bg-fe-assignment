import type { FeedMessage } from "./types";

export interface PipelineStats {
  duplicates: number;
  outOfOrder: number;
  gaps: number;
}

export interface PipelineHandlers {
  onMessage(message: FeedMessage): void;
  onGap?(expected: number, received: number): void;
}

export class FeedPipeline {
  private expectedSeq: number | null = null;

  private readonly buffer = new Map<number, FeedMessage>();
  private readonly handlers: PipelineHandlers;

  private readonly stats: PipelineStats = {
    duplicates: 0,
    outOfOrder: 0,
    gaps: 0,
  };

  constructor(handlers: PipelineHandlers) {
    this.handlers = handlers;
  }

  private emit(message: FeedMessage): void {
    this.handlers.onMessage(message);

    if (this.expectedSeq !== null) {
      this.expectedSeq++;
    }
  }

  receive(message: FeedMessage): void {
    if (this.expectedSeq === null) {
      this.expectedSeq = message.seq;
    }

    const expectedSeq = this.expectedSeq;

    if (expectedSeq === null) {
      return;
    }

    if (message.seq < expectedSeq) {
      this.stats.duplicates++;
      return;
    }

    if (this.buffer.has(message.seq)) {
      this.stats.duplicates++;
      return;
    }

    if (message.seq > expectedSeq) {
      if (this.buffer.size === 0) {
        this.stats.gaps++;
        this.handlers.onGap?.(expectedSeq, message.seq);
      }
      this.stats.outOfOrder++;
      this.buffer.set(message.seq, message);
      return;
    }

    this.emit(message);

    while (this.expectedSeq !== null) {
      const next = this.buffer.get(this.expectedSeq);

      if (!next) {
        break;
      }

      this.buffer.delete(this.expectedSeq);
      this.emit(next);
    }
  }

  reset(snapshotSeq: number): void {
    // Snapshot is authoritative after reconnect.
    // Any buffered feed events may belong to the old connection state.
    this.expectedSeq = snapshotSeq + 1;
    this.buffer.clear();
  }

  getStats(): PipelineStats {
    return { ...this.stats };
  }
}