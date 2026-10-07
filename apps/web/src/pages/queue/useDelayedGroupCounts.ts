import { useEffect, useMemo, useState } from "react";
import { useDelayedGroups } from "@/api/hooks";

/** Scan calls chained on their own (each at most groupScanPerCall jobs) before "scan more". */
const AUTO_CALLS = 10;

export interface DelayedGroupCount {
  delayed: number;
  nextRunAt: number;
}

/**
 * Delayed jobs per BullMQ Pro group. Pro keeps them in the queue's `delayed` zset,
 * not under the group, and counts them nowhere, so they come from a bounded scan of
 * `delayed` (GET /groups-delayed), summed across the slices read so far. `complete`
 * is false while part of the state is unscanned: the counts are lower bounds then.
 */
export function useDelayedGroupCounts(connectionId: string, queue: string, enabled: boolean) {
  const scan = useDelayedGroups(connectionId, queue, { enabled });
  const [roundStart, setRoundStart] = useState(0);
  const pages = scan.data?.pages ?? [];

  useEffect(() => {
    if (enabled && scan.hasNextPage && !scan.isFetching && pages.length - roundStart < AUTO_CALLS) void scan.fetchNextPage();
  }, [enabled, scan, pages.length, roundStart]);

  const counts = useMemo(() => {
    const byId = new Map<string, DelayedGroupCount>();
    for (const p of pages) {
      for (const g of p.groups) {
        const seen = byId.get(g.id);
        if (seen) {
          seen.delayed += g.delayed;
          seen.nextRunAt = Math.min(seen.nextRunAt, g.nextRunAt);
        } else byId.set(g.id, { delayed: g.delayed, nextRunAt: g.nextRunAt });
      }
    }
    return byId;
  }, [pages]);

  return {
    counts,
    loading: enabled && scan.isLoading,
    complete: !!scan.data && !scan.hasNextPage,
    scanning: scan.isFetching,
    scanned: pages.reduce((n, p) => n + p.scanned, 0),
    total: pages.length ? pages[pages.length - 1].total : 0,
    error: scan.error,
    scanMore: scan.hasNextPage && !scan.isFetching ? () => (setRoundStart(pages.length), void scan.fetchNextPage()) : null,
    refetch: () => void scan.refetch(),
  };
}
