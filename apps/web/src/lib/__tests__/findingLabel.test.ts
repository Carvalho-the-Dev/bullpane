import { describe, expect, it } from "vitest";
import type { AttentionFinding } from "@bullpane/shared";
import { findingLabel } from "@/components/queues/QueueAttentionSection";

const base: AttentionFinding = {
  alertId: "a",
  alertName: "r",
  kind: "failed_rate_above",
  scopeType: "global",
  connectionId: "c",
  queueName: "q",
  value: 26.09,
  threshold: 10,
  unit: "%",
  windowMinutes: 15,
  notifies: true,
};

/** The chip is the whole story on the Overview: value, window and bar, readable at a glance. */
describe("findingLabel", () => {
  it("failure rate", () => {
    expect(findingLabel(base)).toBe("26.09% failed · 15m > 10%");
  });
  it("failure count, with the window in hours when it is whole", () => {
    expect(findingLabel({ ...base, kind: "failed_above", unit: "jobs", value: 1234, threshold: 100, windowMinutes: 120 })).toBe("1,234 failed · 2h > 100");
  });
  it("processing time, in ms below a second and s above", () => {
    expect(findingLabel({ ...base, kind: "duration_above", unit: "s", value: 4.2, threshold: 2, percentile: 95 })).toBe("p95 4.2s · 15m > 2.0s");
    expect(findingLabel({ ...base, kind: "duration_above", unit: "s", value: 0.35, threshold: 0.25, percentile: 50 })).toBe("p50 350ms · 15m > 250ms");
  });
  it("waiting has no window", () => {
    expect(findingLabel({ ...base, kind: "waiting_above", unit: "jobs", value: 674, threshold: 200, windowMinutes: null })).toBe("674 waiting > 200");
  });
});
