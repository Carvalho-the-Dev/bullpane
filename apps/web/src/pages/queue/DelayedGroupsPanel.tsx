import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, FastForward, Pause } from "lucide-react";
import { useDelayedGroups, useGroupAction } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { routes } from "@/lib/routes";
import { formatDuration, formatNumber } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { PromoteMatchingDialog } from "@/components/PromoteMatchingDialog";

/** Scan calls chained on their own (each at most groupScanPerCall jobs) before "Scan more". */
const AUTO_CALLS = 10;

/**
 * Groups that have delayed jobs. Pro keeps delayed jobs in the queue's `delayed`
 * zset, not under their group, and indexes no group whose jobs are all delayed, so
 * the list above cannot show them. This one comes from a bounded scan of `delayed`
 * (group fields only, never payloads), summed across the slices scanned so far.
 */
export function DelayedGroupsPanel({ connectionId, queue, proApi }: { connectionId: string; queue: string; proApi: boolean }) {
  const { isOperator } = useAuth();
  const scan = useDelayedGroups(connectionId, queue);
  const groupAction = useGroupAction(connectionId, queue);
  const [promoteGroup, setPromoteGroup] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const now = useNow(5000);

  const pages = scan.data?.pages ?? [];
  useEffect(() => {
    if (scan.hasNextPage && !scan.isFetching && pages.length - round < AUTO_CALLS) void scan.fetchNextPage();
  }, [scan, pages.length, round]);

  const { rows, scanned, total, ungrouped } = useMemo(() => {
    const byId = new Map<string, { id: string; delayed: number; nextRunAt: number }>();
    let scannedSum = 0;
    let ungroupedSum = 0;
    for (const p of pages) {
      scannedSum += p.scanned;
      ungroupedSum += p.ungrouped;
      for (const g of p.groups) {
        const seen = byId.get(g.id);
        if (seen) {
          seen.delayed += g.delayed;
          seen.nextRunAt = Math.min(seen.nextRunAt, g.nextRunAt);
        } else byId.set(g.id, { ...g });
      }
    }
    return {
      rows: [...byId.values()].sort((a, b) => b.delayed - a.delayed),
      scanned: scannedSum,
      total: pages.length ? pages[pages.length - 1].total : 0,
      ungrouped: ungroupedSum,
    };
  }, [pages]);

  const noProApi = proApi ? undefined : "Needs BullMQ Pro's package installed next to Bullpane";
  const pause = (groupId: string) =>
    groupAction.mutate(
      { groupId, action: "pause" },
      { onSuccess: () => toast.success(`Group ${groupId} paused`), onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/50 px-3 py-2 text-xs" role="status">
        <span className="flex items-center gap-2 text-fg-muted">
          <Clock className="size-3.5 text-fg-subtle" aria-hidden />
          <span className="font-medium text-fg">Groups with delayed jobs</span>
          {scan.isLoading ? (
            <Spinner label="Scanning delayed jobs…" />
          ) : (
            <>
              · <span className="num text-fg">{formatNumber(rows.length)}</span> {rows.length === 1 ? "group" : "groups"} · scanned{" "}
              <span className="num text-fg">{formatNumber(Math.min(scanned, Math.max(total, scanned)))}</span> of <span className="num text-fg">{formatNumber(total)}</span> delayed jobs
              {!scan.hasNextPage && scan.data && <span className="text-fg-subtle"> · all scanned</span>}
              {ungrouped > 0 && <span className="text-fg-subtle"> · {formatNumber(ungrouped)} without a group</span>}
            </>
          )}
        </span>
        {scan.hasNextPage && !scan.isFetching && (
          <Button size="sm" onClick={() => (setRound(pages.length), void scan.fetchNextPage())}>
            Scan more
          </Button>
        )}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Group</Th>
            <Th align="right">Delayed</Th>
            <Th align="right">Next run</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {scan.isError && (
            <TableMessage colSpan={4} className="text-danger">
              {errorMessage(scan.error)}
            </TableMessage>
          )}
          {scan.data && rows.length === 0 && !scan.hasNextPage && <TableMessage colSpan={4}>No delayed job belongs to a group.</TableMessage>}
          {rows.map((g) => (
            <Tr key={g.id}>
              <Td mono>
                <Link to={routes.queueGroup(connectionId, queue, g.id, "delayed")} className="text-accent hover:underline" title="List this group's delayed jobs">
                  {g.id}
                </Link>
              </Td>
              <Td num align="right">
                {formatNumber(g.delayed)}
                {scan.hasNextPage && <span className="text-fg-subtle">+</span>}
              </Td>
              <Td num align="right" muted>
                {g.nextRunAt > now ? `in ${formatDuration(g.nextRunAt - now)}` : "due"}
              </Td>
              <Td align="right">
                {isOperator && (
                  <span className="inline-flex items-center gap-1.5">
                    <Button size="xs" variant="secondary" leftIcon={<FastForward />} disabled={!proApi} title={noProApi} onClick={() => setPromoteGroup(g.id)}>
                      Promote all
                    </Button>
                    <Button size="xs" variant="ghost" leftIcon={<Pause />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => pause(g.id)}>
                      Pause
                    </Button>
                  </span>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {promoteGroup && (
        <PromoteMatchingDialog
          open
          onClose={() => {
            setPromoteGroup(null);
            void scan.refetch();
          }}
          connectionId={connectionId}
          queue={queue}
          match={{ groupId: promoteGroup }}
        />
      )}
    </div>
  );
}
