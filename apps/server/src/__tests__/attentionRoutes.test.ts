/**
 * The HTTP contract of Needs attention and of the wider alert rules:
 *  - GET /api/attention is Pro (402 on free) and viewer-readable, served from
 *    the engine's memory;
 *  - a rule can cover every queue or a whole connection, and can have no
 *    channel at all (dashboard only);
 *  - scope and condition are validated, and a change re-evaluates right away.
 */
import { PRO_FEATURES, type AttentionSnapshot, type ProFeature } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db";

const CONN = { id: "conn-1", name: "Prod", url: "redis://localhost:6379", prefix: "bull", cluster: false, queueFilter: null, position: 0, createdAt: new Date() };

const USERS = {
  admin: { id: "u-admin", email: "admin@acme.com", name: "Admin", role: "admin" as const },
  viewer: { id: "u-viewer", email: "viewer@acme.com", name: "Viewer", role: "viewer" as const },
};

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

interface State {
  connections: unknown[];
  alerts: Record<string, unknown>[];
  inserted: Record<string, Record<string, unknown>[]>;
}

/** WHERE is ignored: each test holds at most one row per table, which is all getRow needs. */
function fakeDb(state: State): Db {
  const rowsFor = (name: string): unknown[] => (name === "connections" ? state.connections : name === "alerts" ? state.alerts : []);
  function chain(name: string) {
    const b = {
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      innerJoin: () => b,
      then(resolve: (rows: unknown[]) => unknown) {
        return Promise.resolve(rowsFor(name)).then(resolve);
      },
    };
    return b;
  }
  return {
    select: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    selectDistinct: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    insert: (t: unknown) => ({
      values(v: Record<string, unknown>) {
        const name = tableName(t);
        (state.inserted[name] ??= []).push(v);
        if (name === "alerts") state.alerts.push(v);
        return Object.assign(Promise.resolve(), { onDuplicateKeyUpdate: () => Promise.resolve() });
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Db;
}

async function build(opts: { pro?: boolean; role?: keyof typeof USERS; connections?: unknown[] } = {}) {
  const state: State = { connections: opts.connections ?? [CONN], alerts: [], inserted: {} };
  const config = loadConfig({ SESSION_SECRET: "s".repeat(40), DEMO_MODE: "false" }, { warn: () => undefined });
  const app: FastifyInstance = await buildApp({
    config,
    db: fakeDb(state),
    pool: { get: () => ({}), evict: vi.fn(), closeAll: vi.fn() } as never,
    logger: false,
    serveWeb: false,
  });
  const pro = opts.pro !== false;
  vi.spyOn(app.ctx.edition, "getEdition").mockReturnValue({
    tier: pro ? "pro" : "free",
    demo: false,
    features: Object.fromEntries(PRO_FEATURES.map((f) => [f, pro])) as Record<ProFeature, boolean>,
    license: null,
    pricing: { monthlyUsd: 39, yearlyUsd: 390 },
    checkoutUrl: "",
  });
  const user = USERS[opts.role ?? "admin"];
  app.addHook("onRequest", async (request) => {
    request.user = { ...user, createdAt: new Date(0).toISOString(), lastLoginAt: null, disabledAt: null };
  });
  // The engine's tick is covered elsewhere; here only "a change asks for a re-evaluation" matters.
  const refresh = vi.spyOn(app.ctx.alertsEngine, "refresh").mockImplementation(() => undefined);
  await app.ready();
  return { app, state, refresh };
}

const RATE = { kind: "failed_rate_above", percent: 5, windowMinutes: 15, minSample: 20 };

describe("GET /api/attention", () => {
  it("is Pro: 402 pro_required on the free edition", async () => {
    const { app } = await build({ pro: false });
    const res = await app.inject({ method: "GET", url: "/api/attention" });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: "pro_required", feature: "alerts" });
    await app.close();
  });

  it("serves the engine's snapshot to a viewer, without touching Redis", async () => {
    const { app } = await build({ role: "viewer" });
    const snapshot: AttentionSnapshot = {
      evaluatedAt: "2026-09-26T12:00:00.000Z",
      rules: 1,
      findings: [
        {
          alertId: "a1",
          alertName: "Failure rate",
          kind: "failed_rate_above",
          scopeType: "global",
          connectionId: "conn-1",
          queueName: "payments",
          value: 12.5,
          threshold: 5,
          unit: "%",
          windowMinutes: 15,
          notifies: false,
        },
      ],
      unmeasured: [{ connectionId: "conn-1", queueName: "legacy", reason: "no_metrics" }],
    };
    vi.spyOn(app.ctx.alertsEngine, "attention").mockReturnValue(snapshot);
    const get = vi.spyOn(app.ctx.pool, "get");
    const res = await app.inject({ method: "GET", url: "/api/attention" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(snapshot);
    expect(get).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("wider rules", () => {
  it("creates an every-queue rule with no channel (dashboard only)", async () => {
    const { app, state, refresh } = await build();
    const res = await app.inject({ method: "POST", url: "/api/alerts", payload: { name: "Everywhere", scope: { type: "global" }, condition: RATE } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ scope: { type: "global" }, channels: [] });
    expect(state.inserted["alerts"]?.[0]).toMatchObject({ scopeType: "global", connectionId: null, queueName: null, folderId: null, channels: [] });
    expect(refresh).toHaveBeenCalled();
    await app.close();
  });

  it("creates a whole-connection rule", async () => {
    const { app, state } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { name: "Prod", scope: { type: "connection", connectionId: "conn-1" }, condition: RATE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scope).toEqual({ type: "connection", connectionId: "conn-1" });
    expect(state.inserted["alerts"]?.[0]).toMatchObject({ scopeType: "connection", connectionId: "conn-1", queueName: null });
    await app.close();
  });

  it("refuses a connection rule on a connection that does not exist", async () => {
    const { app } = await build({ connections: [] });
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { name: "Ghost", scope: { type: "connection", connectionId: "nope" }, condition: RATE },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("accepts a processing-time rule and validates it", async () => {
    const { app } = await build();
    const ok = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { name: "Slow", scope: { type: "global" }, condition: { kind: "duration_above", seconds: 2.5, percentile: 95 } },
    });
    expect(ok.statusCode).toBe(201);
    // defaults applied by the shared schema
    expect(ok.json().condition).toEqual({ kind: "duration_above", seconds: 2.5, percentile: 95, windowMinutes: 15, minSample: 5 });

    for (const bad of [
      { kind: "duration_above", seconds: 2, percentile: 90 }, // only p50 / p95
      { kind: "duration_above", seconds: 0 }, // must be positive
      { kind: "duration_above", seconds: 2, minSample: 101 }, // above the sample cap
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/alerts", payload: { name: "x", scope: { type: "global" }, condition: bad } });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    await app.close();
  });

  it("a viewer cannot create rules", async () => {
    const { app } = await build({ role: "viewer" });
    const res = await app.inject({ method: "POST", url: "/api/alerts", payload: { name: "x", scope: { type: "global" }, condition: RATE } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
