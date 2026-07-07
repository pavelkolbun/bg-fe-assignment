import { describe, expect, it } from "vitest";

import { FeedPipeline } from "./pipeline";
import type { FeedMessage } from "./types";

function createMessage(seq: number): FeedMessage {
  return {
    seq,
    serverTime: Date.now(),
    type: "multiplier_tick",
    payload: {
      value: seq,
    },
  };
}

describe("FeedPipeline", () => {
  it("emits messages in order", () => {
    const received: number[] = [];

    const pipeline = new FeedPipeline({
      onMessage(message) {
        received.push(message.seq);
      },
    });

    pipeline.receive(createMessage(1));
    pipeline.receive(createMessage(2));
    pipeline.receive(createMessage(3));

    expect(received).toEqual([1, 2, 3]);
  });

  it("drops duplicate messages", () => {
    const received: number[] = [];

    const pipeline = new FeedPipeline({
      onMessage(message) {
        received.push(message.seq);
      },
    });

    pipeline.receive(createMessage(1));
    pipeline.receive(createMessage(2));
    pipeline.receive(createMessage(2));
    pipeline.receive(createMessage(3));

    expect(received).toEqual([1, 2, 3]);
    expect(pipeline.getStats().duplicates).toBe(1);
  });

  it("reorders buffered messages", () => {
    const received: number[] = [];

    const pipeline = new FeedPipeline({
      onMessage(message) {
        received.push(message.seq);
      },
    });

    pipeline.receive(createMessage(1));
    pipeline.receive(createMessage(3));
    pipeline.receive(createMessage(2));

    expect(received).toEqual([1, 2, 3]);
    expect(pipeline.getStats().outOfOrder).toBe(1);
  });

  it("flushes buffered sequence", () => {
    const received: number[] = [];

    const pipeline = new FeedPipeline({
      onMessage(message) {
        received.push(message.seq);
      },
    });

    pipeline.receive(createMessage(1));
    pipeline.receive(createMessage(4));
    pipeline.receive(createMessage(3));
    pipeline.receive(createMessage(2));

    expect(received).toEqual([1, 2, 3, 4]);
  });
});