/**
 * Seeded-ish random helpers. No faker dependency: the demo only needs data
 * that *looks* real in a job list (emails, names, amounts, tenant ids), and a
 * seeded generator keeps runs reproducible enough to debug.
 */

// mulberry32 — tiny, fast, good enough for fake data.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Number(process.env.SIM_SEED ?? Date.now() % 100_000);
const next = mulberry32(seed);

export function rand(): number {
  return next();
}

/** Integer in [min, max] inclusive. */
export function int(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function float(min: number, max: number, decimals = 2): number {
  return Number((rand() * (max - min) + min).toFixed(decimals));
}

export function chance(p: number): boolean {
  return rand() < p;
}

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

export function shuffle<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Everything person-shaped is redacted at the source: the public demo shows
 * these payloads to anyone, and realistic names, emails or phone numbers read
 * as leaked PII even when they are invented. Values keep their shape (a masked
 * email still looks like an email) so the job list stays believable.
 */
const INITIALS = "ABCDEFGHIJKLMNOPRSTVWZ";
// RFC 2606 reserved domains: guaranteed never to belong to anyone.
const DOMAINS = ["example.com", "example.org", "example.net"];

function initial(): string {
  return pick(INITIALS.split(""));
}

export const TENANTS = [
  "tenant-acme", "tenant-globex", "tenant-initech", "tenant-umbrella", "tenant-hooli",
  "tenant-piedpiper", "tenant-stark", "tenant-wayne", "tenant-wonka", "tenant-vandelay",
  "tenant-dunder", "tenant-cyberdyne",
] as const;
export type TenantId = (typeof TENANTS)[number];

export function tenant(): TenantId {
  return pick(TENANTS);
}

/** Masked first name, e.g. `M***`. */
export function firstName(): string {
  return `${initial()}***`;
}

/** Masked full name, e.g. `M*** S***`. */
export function fullName(): string {
  return `${initial()}*** ${initial()}***`;
}

/** Masked email on a reserved domain, e.g. `m***.s***@example.com`. */
export function email(): string {
  const f = initial().toLowerCase();
  const l = initial().toLowerCase();
  return `${f}***.${l}***@${pick(DOMAINS)}`;
}

/** Masked phone number: only the last four digits survive. */
export function phone(): string {
  return `+55 ** *****-${int(1000, 9999)}`;
}

/** Money amount in cents, skewed toward small values like a real ledger. */
export function amountCents(): number {
  const r = rand();
  if (r < 0.6) return int(500, 9_900);
  if (r < 0.9) return int(9_900, 89_900);
  return int(89_900, 1_500_000);
}

export const CURRENCIES = ["BRL", "USD", "EUR", "GBP", "MXN"] as const;
export function currency(): string {
  return chance(0.7) ? "BRL" : pick(CURRENCIES);
}

export function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** An address from the RFC 5737 documentation ranges, never a routable host. */
export function ipv4(): string {
  return `${pick(["192.0.2", "198.51.100", "203.0.113"])}.${int(1, 254)}`;
}

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat".split(
    " ",
  );

export function sentence(words = int(6, 14)): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(pick(WORDS));
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/**
 * Builds a JSON-serialisable blob of roughly `kb` kilobytes. Used to prove the
 * dashboard truncates previews inside Redis instead of shipping the whole
 * payload to the browser.
 */
export function bigBlob(kb: number): Record<string, unknown> {
  const target = kb * 1024;
  const lines: string[] = [];
  let size = 0;
  while (size < target) {
    const line = `${new Date().toISOString()} ${pick(["INFO", "DEBUG", "WARN"])} ${sentence(int(8, 16))}`;
    lines.push(line);
    size += line.length + 3;
  }
  return {
    _note: `intentionally large payload (~${kb} KB) so the dashboard has to truncate previews`,
    lines,
  };
}

/** A fake but plausible multi-frame stack trace, for "long stack" failures. */
export function longStackError(message: string, frames = 28): Error {
  const err = new Error(message);
  const files = [
    "src/services/thumbnail.ts", "src/lib/sharp-wrapper.ts", "node_modules/sharp/lib/output.js",
    "src/workers/media.ts", "node_modules/bullmq/dist/esm/classes/worker.js",
    "src/infra/s3-client.ts", "node_modules/@aws-sdk/client-s3/dist-cjs/index.js",
    "node:internal/process/task_queues", "src/utils/retry.ts",
  ];
  const fns = [
    "resizeBuffer", "processImage", "Sharp.toBuffer", "uploadVariant", "S3Client.send",
    "withRetry", "Worker.processJob", "runMicrotasks", "processTicksAndRejections", "async Promise.all (index 2)",
  ];
  const lines = [`Error: ${message}`];
  for (let i = 0; i < frames; i++) {
    lines.push(`    at ${pick(fns)} (${pick(files)}:${int(10, 900)}:${int(1, 80)})`);
  }
  err.stack = lines.join("\n");
  return err;
}
