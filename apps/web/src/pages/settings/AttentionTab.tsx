import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { routes } from "@/lib/routes";
import { useEdition } from "@/edition/useEdition";
import { useAlerts } from "@/api/hooks";
import { DEFAULT_ATTENTION_THRESHOLDS, attentionThresholdsSchema } from "@bullpane/shared";
import { useAttentionThresholds, useUpdateAttentionThresholds } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";

/**
 * What decides the Overview's "Needs attention" section.
 *
 * Free edition: two global numbers on top of built-in heuristics. Pro: the
 * alert rules — scoped per queue, folder, connection or everywhere, measured
 * from BullMQ metrics over a window — and these two numbers are not used, so
 * the tab says so instead of offering settings that do nothing. The free
 * version stays useful on its own; the upgrade is precision, not the basics.
 */
export function AttentionTab() {
  const { has } = useEdition();
  if (has("alerts")) return <AttentionFromRules />;
  return <AttentionThresholdsForm />;
}

function AttentionFromRules() {
  const alerts = useAlerts();
  const list = alerts.data ?? [];
  const enabled = list.filter((a) => a.enabled);
  const byScope = (t: string) => enabled.filter((a) => a.scope.type === t).length;
  return (
    <div className="max-w-xl space-y-4">
      <p className="text-xs text-fg-muted">
        <strong className="font-medium text-fg">Needs attention</strong> is driven by your alert rules. Every queue that breaks
        an enabled rule gets a card at the top of the Overview, with the value, the window and the threshold. Paused queues and
        queues with a backlog but no worker are always flagged.
      </p>
      <ul className="space-y-1 text-xs text-fg-muted">
        <li>
          Scope each rule to <span className="text-fg">every queue</span>, a <span className="text-fg">connection</span>, a{" "}
          <span className="text-fg">folder</span> or <span className="text-fg">one queue</span>. The most specific rule of each
          kind wins, so a queue rule overrides the global one for that queue.
        </li>
        <li>Failure count and failure rate come from BullMQ metrics over the window, so removeOnComplete cannot skew them.</li>
        <li>Processing time is the p50 or p95 of the jobs completed in the window.</li>
        <li>A rule without channels is dashboard only; add Slack or a webhook to be notified as well.</li>
      </ul>
      <p className="text-xs text-fg-subtle">
        {enabled.length === 0
          ? "No enabled rule yet."
          : `${enabled.length} enabled: ${byScope("global")} on every queue, ${byScope("connection")} per connection, ${byScope("folder")} per folder, ${byScope("queue")} per queue.`}
      </p>
      <Link to={routes.alerts} className="inline-flex text-xs text-accent hover:underline">
        Manage rules →
      </Link>
    </div>
  );
}

function AttentionThresholdsForm() {
  const { isAdmin } = useAuth();
  const query = useAttentionThresholds();
  const save = useUpdateAttentionThresholds();

  // Text, not number: an empty box during editing is a valid intermediate state
  // and `<input type=number>` reports it as NaN, which would fight the user.
  const [waiting, setWaiting] = useState("");
  const [failed, setFailed] = useState("");

  const loaded = query.data;
  useEffect(() => {
    if (!loaded) return;
    setWaiting(String(loaded.waitingAbove));
    setFailed(String(loaded.failedAbove));
  }, [loaded]);

  if (query.isLoading) return <Spinner />;

  const parsed = attentionThresholdsSchema.safeParse({
    waitingAbove: Number(waiting === "" ? 0 : waiting),
    failedAbove: Number(failed === "" ? 0 : failed),
  });
  const dirty =
    !!loaded && parsed.success && (parsed.data.waitingAbove !== loaded.waitingAbove || parsed.data.failedAbove !== loaded.failedAbove);

  const onSave = () => {
    if (!parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => toast.success("Attention thresholds saved"),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <div className="max-w-xl space-y-5">
      <p className="text-xs text-fg-muted">
        When a queue shows up in <strong className="font-medium text-fg">Needs attention</strong> at the top of the Overview.
        Failing, paused and stuck-with-no-worker queues are always flagged — these two add the cases only you can define.
        <span className="text-fg-subtle"> Set 0 to turn a rule off.</span>
      </p>
      <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">Pro:</span> rules per queue, folder, connection or everywhere, on failure rate
        and processing time over a window, measured from BullMQ metrics — the same rules can notify Slack or a webhook.{" "}
        <Link to={routes.alerts} className="text-accent hover:underline">
          See Alerts
        </Link>
      </p>

      <Input
        label="Waiting above"
        hint="Flag a queue whose waiting backlog passes this, even when a worker is draining it. Leave at 0 if your queues run deep on purpose."
        inputMode="numeric"
        value={waiting}
        disabled={!isAdmin}
        onChange={(e) => setWaiting(e.target.value.replace(/[^0-9]/g, ""))}
      />

      <Input
        label="Failed above"
        hint="Flag a queue whose failed list passes this. At 0 any failed job at all is flagged, which is the previous behaviour."
        inputMode="numeric"
        value={failed}
        disabled={!isAdmin}
        onChange={(e) => setFailed(e.target.value.replace(/[^0-9]/g, ""))}
      />

      {isAdmin ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setWaiting(String(loaded?.waitingAbove ?? DEFAULT_ATTENTION_THRESHOLDS.waitingAbove));
                setFailed(String(loaded?.failedAbove ?? DEFAULT_ATTENTION_THRESHOLDS.failedAbove));
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">Only an administrator can change these.</p>
      )}
    </div>
  );
}
