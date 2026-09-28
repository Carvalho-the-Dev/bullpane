import { describe, expect, it } from "vitest";
import { DEFAULT_ATTENTION_THRESHOLDS, type AttentionFinding, type AttentionThresholds } from "@bullpane/shared";
import { attentionReasons, splitByAttention } from "../queueAttention";
import type { QueueEntry } from "../groupQueues";

function entry(over: {
  name?: string;
  waiting?: number;
  prioritized?: number;
  active?: number;
  failed?: number;
  paused?: boolean;
  ratesFailed?: number;
  ratesCompleted?: number;
}): QueueEntry {
  return {
    connection: { id: "c1", name: "prod" },
    queue: {
      name: over.name ?? "q",
      counts: {
        waiting: over.waiting ?? 0,
        prioritized: over.prioritized ?? 0,
        active: over.active ?? 0,
        failed: over.failed ?? 0,
        completed: 0,
        delayed: 0,
        paused: 0,
        "waiting-children": 0,
      },
      isPaused: over.paused ?? false,
      rates: { completed: over.ratesCompleted ?? 0, failed: over.ratesFailed ?? 0 },
    },
    // the helpers only touch connection.id/name and the queue fields above
  } as unknown as QueueEntry;
}

const OFF = DEFAULT_ATTENTION_THRESHOLDS;
const th = (waitingAbove: number, failedAbove: number): AttentionThresholds => ({ waitingAbove, failedAbove });

describe("attentionReasons — defaults unchanged", () => {
  it("flags nothing for an idle, clean queue", () => {
    expect(attentionReasons(entry({}), OFF)).toEqual([]);
  });

  it("does not flag a deep queue that has a live worker", () => {
    expect(attentionReasons(entry({ waiting: 50_000, active: 4 }), OFF)).toEqual([]);
  });

  it("still flags waiting with no worker as backlog", () => {
    expect(attentionReasons(entry({ waiting: 1 }), OFF)).toEqual(["backlog"]);
  });

  it("flags any failed job when no threshold is set", () => {
    expect(attentionReasons(entry({ failed: 1, active: 1, ratesCompleted: 10 }), OFF)).toEqual(["failed"]);
  });
});

describe("waitingAbove", () => {
  it("flags a deep queue even though a worker is draining it", () => {
    expect(attentionReasons(entry({ waiting: 5_001, active: 3, ratesCompleted: 100 }), th(5_000, 0))).toEqual(["waiting"]);
  });

  it("is exclusive, not inclusive: exactly at the threshold is fine", () => {
    expect(attentionReasons(entry({ waiting: 5_000, active: 3, ratesCompleted: 100 }), th(5_000, 0))).toEqual([]);
  });

  it("counts prioritized jobs as part of the backlog", () => {
    expect(attentionReasons(entry({ waiting: 6, prioritized: 5, active: 1, ratesCompleted: 9 }), th(10, 0))).toEqual(["waiting"]);
  });

  it("does not stack on top of backlog — a stuck queue gets one chip, not two", () => {
    expect(attentionReasons(entry({ waiting: 9_999 }), th(10, 0))).toEqual(["backlog"]);
  });

  it("0 disables the rule", () => {
    expect(attentionReasons(entry({ waiting: 1_000_000, active: 2, ratesCompleted: 5 }), th(0, 0))).toEqual([]);
  });
});

describe("failedAbove", () => {
  it("replaces the any-failed bar rather than adding to it", () => {
    expect(attentionReasons(entry({ failed: 5, active: 1, ratesCompleted: 10 }), th(0, 10))).toEqual([]);
    expect(attentionReasons(entry({ failed: 11, active: 1, ratesCompleted: 10 }), th(0, 10))).toEqual(["failed"]);
  });

  it("fires alongside other reasons, unlike the default any-failed rule", () => {
    // with no threshold `failed` is suppressed when something else already fired
    expect(attentionReasons(entry({ failed: 99, paused: true }), OFF)).toEqual(["paused"]);
    expect(attentionReasons(entry({ failed: 99, paused: true }), th(0, 10))).toEqual(["paused", "failed"]);
  });
});

describe("splitByAttention", () => {
  it("ranks a stuck queue above one that is merely deep", () => {
    const stuck = entry({ name: "stuck", waiting: 5 });
    const deep = entry({ name: "deep", waiting: 100_000, active: 2, ratesCompleted: 50 });
    const { attention } = splitByAttention([deep, stuck], th(10, 0));
    expect(attention.map((a) => a.entry.queue.name)).toEqual(["stuck", "deep"]);
  });

  it("puts unflagged queues in rest", () => {
    const { attention, rest } = splitByAttention([entry({ name: "ok", active: 1, ratesCompleted: 3 })], th(10, 0));
    expect(attention).toHaveLength(0);
    expect(rest.map((r) => r.queue.name)).toEqual(["ok"]);
  });
});

describe("splitByAttention — Pro, driven by rule findings", () => {
  const finding = (queueName: string, over: Partial<AttentionFinding> = {}): AttentionFinding => ({
    alertId: `r-${queueName}`,
    alertName: "rule",
    kind: "failed_rate_above",
    scopeType: "global",
    connectionId: "c1",
    queueName,
    value: 20,
    threshold: 5,
    unit: "%",
    windowMinutes: 15,
    notifies: false,
    ...over,
  });

  it("flags queues with findings and drops the rate/depth heuristics", () => {
    // `failing` (rates) and `failed` (pile) would flag this in free; in Pro only a rule can.
    const noisy = entry({ name: "noisy", failed: 500, ratesFailed: 3, active: 1, ratesCompleted: 100 });
    const broken = entry({ name: "broken", active: 1, ratesCompleted: 10 });
    const { attention, rest } = splitByAttention([noisy, broken], OFF, 8, [finding("broken")]);
    expect(attention.map((a) => a.entry.queue.name)).toEqual(["broken"]);
    expect(attention[0]!.findings).toHaveLength(1);
    expect(rest.map((r) => r.queue.name)).toEqual(["noisy"]);
  });

  it("keeps paused and no-worker backlog as built-in checks", () => {
    const paused = entry({ name: "paused", paused: true });
    const stuck = entry({ name: "stuck", waiting: 3 });
    const { attention } = splitByAttention([paused, stuck], OFF, 8, []);
    expect(attention.map((a) => [a.entry.queue.name, a.reasons])).toEqual([
      ["paused", ["paused"]],
      ["stuck", ["backlog"]],
    ]);
  });

  it("ranks a failure finding above a paused queue, and the worse breach first", () => {
    const paused = entry({ name: "paused", paused: true });
    const a = entry({ name: "a", active: 1, ratesCompleted: 5 });
    const b = entry({ name: "b", active: 1, ratesCompleted: 5 });
    const { attention } = splitByAttention([paused, a, b], OFF, 8, [finding("a", { value: 6 }), finding("b", { value: 60 })]);
    expect(attention.map((x) => x.entry.queue.name)).toEqual(["b", "a", "paused"]);
  });

  it("ranks every rule finding, even a slow queue, above a paused one", () => {
    const paused = entry({ name: "paused", paused: true, waiting: 0 });
    const slowQ = entry({ name: "slow", active: 1, ratesCompleted: 5 });
    const { attention } = splitByAttention([paused, slowQ], OFF, 8, [finding("slow", { kind: "duration_above", unit: "s", value: 1.2, threshold: 1 })]);
    expect(attention.map((x) => x.entry.queue.name)).toEqual(["slow", "paused"]);
  });

  it("matches findings by connection too", () => {
    const q = entry({ name: "shared", active: 1, ratesCompleted: 5 });
    const { attention } = splitByAttention([q], OFF, 8, [finding("shared", { connectionId: "other" })]);
    expect(attention).toHaveLength(0);
  });
});
